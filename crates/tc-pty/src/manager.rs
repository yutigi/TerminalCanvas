//! Terminal lifecycle, from `src/terminal-manager.cjs`.
//!
//! Terminal processes belong to the host; the UI only receives this lifecycle API. The manager is
//! a state machine owned by one host task, which hands it every command and every process event in
//! order, as Node's event loop did for the JavaScript host. Process threads report back through an
//! [`EventSink`] with a [`SessionKey`]; the generation in the key makes events from a stopped or
//! restarted terminal harmless, like the JavaScript `sessions.get(id) !== entry` checks.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde::ser::{SerializeMap, Serializer};
use serde_json::Value;
use tc_core::js::{trim, truthy, utf16_len};
use tc_core::launch::{LaunchRequest, take_finish, take_requests, write_result};
use tc_core::osc::{DirectoryReports, Report};
use tc_core::recovery::CardMetadata;
use tc_core::session::{Launch, LaunchToken, MetadataEvent, MetadataParser, MetadataPatch, Provider, session_metadata};
use tc_core::workspace::{Card, VERSION, validate_card};
use tc_core::{Error, Platform, Result};

use crate::daemon::Daemon;
use crate::integration::{self, Integration};
use crate::shell::{POWERSHELL_BOOTSTRAP, powershell_args};
use crate::tmux::{self, Tmux};

/// The most input one write may carry, in UTF-16 units.
pub const MAX_INPUT_UNITS: usize = 65536;
/// Unacknowledged output above this pauses reading from the terminal.
pub const HIGH_WATER: usize = 256_000;
/// Reading resumes once unacknowledged output drops below this.
pub const LOW_WATER: usize = 32_000;
/// How long Stop waits for a killed terminal to exit.
pub const STOP_TIMEOUT: Duration = Duration::from_secs(5);
/// How often the host should call [`TerminalManager::poll_hooks`].
pub const HOOK_POLL_INTERVAL: Duration = Duration::from_millis(500);
const ACK_LIMIT: f64 = 1024.0 * 1024.0;
const SESSION_FILE_LIMIT: u64 = 8192;

/// One run of one card. A restarted card gets a new generation.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SessionKey {
    pub id: String,
    pub generation: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExitStatus {
    pub code: i64,
    /// The signal that ended the shell, on macOS and Linux.
    pub signal: Option<i32>,
}

/// What a terminal's threads report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionEvent {
    Output(String),
    Exit(ExitStatus),
    /// Another desktop view deliberately took over this helper attachment.
    Superseded,
    /// A polled process directory (macOS and Linux), or `None` when unknown.
    Directory(Option<String>),
    /// Integration escape sequences read from tmux (see [`crate::tmux`]). The manager handles them
    /// like output, but they are never shown.
    Report(String),
}

pub type EventSink = Arc<dyn Fn(SessionKey, SessionEvent) + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnRequest {
    pub shell: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub env: BTreeMap<String, String>,
}

/// A running terminal process.
pub trait Process: Send {
    fn pid(&self) -> Option<u32>;
    /// Queues input. Writing never waits for the shell to read it.
    fn write(&mut self, data: &str) -> io::Result<()>;
    fn resize(&mut self, cols: u16, rows: u16) -> io::Result<()>;
    /// Stops reading output, so a flooding program blocks instead of filling memory.
    fn pause(&mut self);
    fn resume(&mut self);
    /// The UI has written `units` UTF-16 units of this terminal's output. A backend that counts
    /// output where it reads it can pause without waiting for [`Self::pause`].
    fn acknowledge(&mut self, units: usize);
    /// Ends the terminal and every process it started. The exit arrives as a [`SessionEvent::Exit`].
    fn kill(&mut self);
}

/// Starts terminal processes and directory polling.
pub trait Backend: Send {
    fn spawn(&mut self, request: &SpawnRequest, key: SessionKey, events: EventSink) -> io::Result<Box<dyn Process>>;
    /// Polls `pid`'s directory on macOS and Linux, reporting [`SessionEvent::Directory`] until the
    /// returned handle is dropped.
    fn watch_directory(&mut self, pid: u32, platform: Platform, key: SessionKey, events: EventSink) -> Box<dyn Send>;
}

/// What keeps terminals running after the app quits (see [`TerminalManager::set_keeper`]). Each
/// kept terminal is named by its card ID.
#[derive(Debug, Clone)]
pub enum Keeper {
    /// The app's own helper process (Windows; see [`crate::daemon`]).
    Daemon(Daemon),
    /// tmux sessions (macOS and Linux; see [`crate::tmux`]).
    Tmux(Tmux),
}

impl Keeper {
    /// The cards whose terminals are kept running.
    pub fn sessions(&self) -> Vec<String> {
        match self {
            Keeper::Daemon(daemon) => daemon.terminals().into_iter().map(|kept| kept.id).collect(),
            Keeper::Tmux(tmux) => tmux.sessions(),
        }
    }

    /// Whether the card's terminal is kept running, with the integration it started with.
    fn find(&self, card: &str) -> Option<Option<Integration>> {
        match self {
            Keeper::Daemon(daemon) => daemon
                .terminals()
                .into_iter()
                .find(|kept| kept.id == card)
                .map(|kept| kept.integration),
            Keeper::Tmux(tmux) => tmux.has_session(card).then(|| tmux.integration(card)),
        }
    }

    fn has_session(&self, card: &str) -> bool {
        match self {
            Keeper::Daemon(_) => self.find(card).is_some(),
            Keeper::Tmux(tmux) => tmux.has_session(card),
        }
    }

    /// Ends the card's kept terminal and everything running in it.
    pub fn kill_session(&self, card: &str) {
        match self {
            Keeper::Daemon(daemon) => daemon.kill(card),
            Keeper::Tmux(tmux) => tmux.kill_session(card),
        }
    }
}

/// Writes a terminal's integration files, given its shell and platform.
pub type Integrations = Box<dyn FnMut(&str, Platform) -> io::Result<Option<Integration>> + Send>;

/// What the manager tells the UI. Serializes to the JavaScript host's event objects.
#[derive(Debug, Clone, PartialEq)]
pub enum TerminalEvent {
    Data {
        id: String,
        data: String,
    },
    Exit {
        id: String,
        status: ExitStatus,
    },
    /// A lost terminal was reattached, or its dead shell was replaced.
    Recovered {
        id: String,
        previous_exit: Option<ExitStatus>,
    },
    /// The live directory, or `None` when the shell reported an unusable one.
    Cwd {
        id: String,
        cwd: Option<String>,
    },
    /// The directory and AI session to restore. `initial` marks the event sent at start.
    Metadata {
        id: String,
        metadata: CardMetadata,
        initial: bool,
    },
    Error {
        id: String,
        message: String,
    },
    /// A program in terminal `id` asked for a new terminal; the UI creates it next to `id`. The
    /// host answers request `request_id` in `inbox` once the UI reports the outcome.
    Launch {
        id: String,
        request_id: String,
        inbox: std::path::PathBuf,
        request: LaunchRequest,
    },
}

impl Serialize for TerminalEvent {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        match self {
            TerminalEvent::Data { id, data } => {
                map.serialize_entry("type", "data")?;
                map.serialize_entry("id", id)?;
                map.serialize_entry("data", data)?;
            }
            TerminalEvent::Exit { id, status } => {
                map.serialize_entry("type", "exit")?;
                map.serialize_entry("id", id)?;
                map.serialize_entry("exitCode", &status.code)?;
                if let Some(signal) = status.signal {
                    map.serialize_entry("signal", &signal)?;
                }
            }
            TerminalEvent::Recovered { id, previous_exit } => {
                map.serialize_entry("type", "recovered")?;
                map.serialize_entry("id", id)?;
                if let Some(status) = previous_exit {
                    map.serialize_entry("exitCode", &status.code)?;
                    if let Some(signal) = status.signal {
                        map.serialize_entry("signal", &signal)?;
                    }
                }
            }
            TerminalEvent::Cwd { id, cwd } => {
                map.serialize_entry("type", "cwd")?;
                map.serialize_entry("id", id)?;
                map.serialize_entry("cwd", cwd)?;
            }
            TerminalEvent::Metadata { id, metadata, initial } => {
                map.serialize_entry("type", "metadata")?;
                map.serialize_entry("id", id)?;
                map.serialize_entry("cwd", &metadata.cwd)?;
                map.serialize_entry("session", &metadata.session)?;
                if *initial {
                    map.serialize_entry("initial", &true)?;
                }
            }
            TerminalEvent::Error { id, message } => {
                map.serialize_entry("type", "error")?;
                map.serialize_entry("id", id)?;
                map.serialize_entry("message", message)?;
            }
            TerminalEvent::Launch {
                id,
                request_id,
                request,
                ..
            } => {
                map.serialize_entry("type", "launch")?;
                map.serialize_entry("id", id)?;
                map.serialize_entry("request", request_id)?;
                map.serialize_entry("profile", &request.profile)?;
                map.serialize_entry("title", &request.title)?;
                if let Some(mode) = request.title_mode {
                    map.serialize_entry("titleMode", &mode)?;
                }
                map.serialize_entry("cwd", &request.cwd)?;
                map.serialize_entry("command", &request.command)?;
            }
        }
        map.end()
    }
}

/// The `start` result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Started {
    pub id: String,
    pub pid: Option<u32>,
    pub shell: String,
    pub metadata: CardMetadata,
    /// The terminal outlives the app (tmux, or the Windows helper).
    pub kept: bool,
}

impl Serialize for Started {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(if self.kept { 6 } else { 5 }))?;
        map.serialize_entry("id", &self.id)?;
        map.serialize_entry("pid", &self.pid)?;
        map.serialize_entry("cwd", &self.metadata.cwd)?;
        map.serialize_entry("shell", &self.shell)?;
        map.serialize_entry("session", &self.metadata.session)?;
        // Only kept terminals add a field, so other results keep the JavaScript host's shape.
        if self.kept {
            map.serialize_entry("kept", &true)?;
        }
        map.end()
    }
}

/// The folder to offer for a duplicate, with a warning when it is only a suggestion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DirectoryChoice {
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

/// A duplicate needs the shell's live directory, which takes a process lookup on macOS and Linux.
/// The host runs [`crate::cwd::process_directory`] off the manager's task and passes the result
/// to [`TerminalManager::finish_directory`].
#[derive(Debug)]
pub enum DirectoryRequest {
    Ready(DirectoryChoice),
    Lookup(PendingLookup),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingLookup {
    pub pid: u32,
    pub platform: Platform,
    key: SessionKey,
    card_cwd: String,
}

/// Machine facts the manager needs, fixed when it is created.
#[derive(Debug, Clone)]
pub struct Config {
    pub platform: Platform,
    /// The environment new shells inherit.
    pub env: BTreeMap<String, String>,
    pub home: String,
    /// This machine's name, for OSC 7 reports.
    pub hostname: String,
    /// The host's working directory, the last fallback for a duplicate.
    pub process_cwd: String,
    /// The folder of Claude Code accounts (see [`tc_core::accounts`]). Without it, a card's
    /// account is ignored and every shell keeps the inherited `CLAUDE_CONFIG_DIR`.
    pub claude_accounts: Option<std::path::PathBuf>,
}

impl Config {
    /// This process's platform, environment, home folder, hostname, and working directory.
    pub fn from_environment() -> Self {
        let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .map(|home| home.to_string_lossy().into_owned())
            .unwrap_or_default();
        Config {
            platform: Platform::current(),
            env: std::env::vars_os()
                .filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)))
                .collect(),
            home,
            hostname: gethostname::gethostname().to_string_lossy().into_owned(),
            process_cwd: std::env::current_dir()
                .map(|cwd| cwd.to_string_lossy().into_owned())
                .unwrap_or_default(),
            claude_accounts: None,
        }
    }
}

struct Session {
    card: Card,
    /// Prevents a failing shell or connection from continually restarting.
    retry_after: Option<Instant>,
    name_homes: [std::path::PathBuf; 2],
    name_session: Option<tc_core::session::SessionMetadata>,
    size: (u16, u16),
    generation: u64,
    process: Box<dyn Process>,
    integration: Option<Integration>,
    /// The last live directory report; `None` until the first one.
    cwd: Option<Option<String>>,
    /// Whether the shell is idle at a prompt (Windows integration).
    ready: bool,
    /// Output sent to the UI and not yet acknowledged, in UTF-16 units.
    pending: usize,
    paused: bool,
    parser: MetadataParser,
    reports: DirectoryReports,
    launch: Option<Launch>,
    watch: Option<Box<dyn Send>>,
    /// What keeps this terminal running after the app lets go of it.
    keeper: Option<Keeper>,
}

struct Stopping {
    key: SessionKey,
    deadline: Instant,
    _process: Box<dyn Process>,
}

pub struct TerminalManager {
    config: Config,
    backend: Box<dyn Backend>,
    integrations: Option<Integrations>,
    events: EventSink,
    sessions: HashMap<String, Session>,
    metadata: HashMap<String, CardMetadata>,
    stopping: Vec<Stopping>,
    generation: u64,
    outbox: Vec<TerminalEvent>,
    /// The last terminal started without the integration it should have had. A folder that stays
    /// broken fails every start, and one notice covers them until a start succeeds.
    integration_failing: bool,
    /// When set, terminals start kept running, so they outlive the app.
    keeper: Option<Keeper>,
    tmux_watch: Option<tmux::Watch>,
}

/// Set for every terminal, apart from its integration's variables.
const CANVAS_ENV: &str = "TERMINAL_CANVAS";

/// What rustup and `cargo run` set for the program they start, describing that one launch.
const CARGO_LAUNCH_ENV: &[&str] = &[
    "CARGO",
    "CARGO_BIN_NAME",
    "CARGO_CRATE_NAME",
    "CARGO_MANIFEST_DIR",
    "CARGO_MANIFEST_PATH",
    "CARGO_PRIMARY_PACKAGE",
    "RUSTUP_TOOLCHAIN",
    "RUSTUP_TOOLCHAIN_SOURCE",
    "RUST_RECURSION_COUNT",
];
const CARGO_PKG_PREFIX: &str = "CARGO_PKG_";

/// When the app runs from source (`cargo run`), rustup and Cargo add the launch's variables and put
/// the app's toolchain and build folders on the path. Shells must not inherit them:
/// `RUSTUP_TOOLCHAIN` overrides `rust-toolchain.toml`, so every `cargo` in a terminal would build
/// with the app's Rust version instead of the project's. Without a launch marker nothing changes,
/// so a `RUSTUP_TOOLCHAIN` the user set themselves is kept.
fn remove_cargo_launch(env: &mut BTreeMap<String, String>, windows: bool) {
    let same = |a: &str, b: &str| if windows { a.eq_ignore_ascii_case(b) } else { a == b };
    let value = |env: &BTreeMap<String, String>, name: &str| {
        env.iter()
            .find(|(key, _)| same(key, name))
            .map(|(_, value)| value.clone())
    };
    let manifest_dir = value(env, "CARGO_MANIFEST_DIR");
    if manifest_dir.is_none() && value(env, "RUST_RECURSION_COUNT").is_none() {
        return;
    }
    let (separator, list) = if windows { ('\\', ';') } else { ('/', ':') };
    let normal = |path: &str| {
        let path = if windows {
            path.replace('/', "\\").to_lowercase()
        } else {
            path.to_owned()
        };
        path.trim_end_matches(separator).to_owned()
    };
    // The toolchain's own folders, and the workspace's `target` folder wherever it is above the manifest.
    let mut added = Vec::new();
    if let (Some(home), Some(toolchain)) = (value(env, "RUSTUP_HOME"), value(env, "RUSTUP_TOOLCHAIN")) {
        added.push(normal(&format!("{home}{separator}toolchains{separator}{toolchain}")));
    }
    if let Some(dir) = &manifest_dir {
        let mut dir = normal(dir);
        loop {
            added.push(format!("{dir}{separator}target"));
            match dir.rfind(separator) {
                Some(end) => dir.truncate(end),
                None => break,
            }
        }
    }
    let launched = |entry: &str| {
        let entry = normal(entry);
        added.iter().any(|dir| {
            entry
                .strip_prefix(dir.as_str())
                .is_some_and(|rest| rest.is_empty() || rest.starts_with(separator))
        })
    };
    for (key, value) in env.iter_mut() {
        if same(key, "PATH") {
            *value = value
                .split(list)
                .filter(|entry| !launched(entry))
                .collect::<Vec<_>>()
                .join(&list.to_string());
        }
    }
    env.retain(|key, _| {
        let upper = key.to_ascii_uppercase();
        let key = if windows { upper.as_str() } else { key.as_str() };
        !CARGO_LAUNCH_ENV.contains(&key) && !key.starts_with(CARGO_PKG_PREFIX)
    });
}

/// Why a terminal started without integration, what that costs, and what to do about it.
fn integration_warning(error: &io::Error) -> String {
    let fix = match error.kind() {
        io::ErrorKind::PermissionDenied | io::ErrorKind::ReadOnlyFilesystem => "Make that location writable",
        io::ErrorKind::NotFound => {
            "Make sure that folder exists (the temporary folder comes from TMP or TEMP on Windows, TMPDIR elsewhere)"
        }
        io::ErrorKind::StorageFull | io::ErrorKind::QuotaExceeded => "Free some disk space",
        _ => "Fix the problem with that location",
    };
    format!(
        "This terminal started without Terminal Canvas integration ({error}): its AI session will not be saved, and programs in it cannot open terminals on the canvas. {fix}, then restart the terminal. Until then, other terminals start the same way without another notice."
    )
}

fn invalid<T>(message: &str) -> Result<T> {
    Err(Error::Invalid(message.to_owned()))
}

/// `/^(?:pwsh|powershell|cmd)(?:\.exe)?$/i`
fn is_shell_launcher(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    let name = lower.strip_suffix(".exe").unwrap_or(&lower);
    matches!(name, "pwsh" | "powershell" | "cmd")
}

/// `/^cmd(?:\.exe)?$/i` on the whole shell string.
fn is_bare_cmd(shell: &str) -> bool {
    matches!(shell.to_ascii_lowercase().as_str(), "cmd" | "cmd.exe")
}

fn integer(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.fract() == 0.0)
}

/// Columns 2–500 and rows 1–300, both integers.
pub fn dimensions(cols: &Value, rows: &Value) -> Result<(u16, u16)> {
    match (integer(cols), integer(rows)) {
        (Some(cols), Some(rows)) if (2.0..=500.0).contains(&cols) && (1.0..=300.0).contains(&rows) => {
            Ok((cols as u16, rows as u16))
        }
        _ => invalid("Invalid terminal dimensions."),
    }
}

fn is_directory(path: &str) -> bool {
    fs::metadata(path).is_ok_and(|metadata| metadata.is_dir())
}

impl TerminalManager {
    pub fn new(
        mut config: Config,
        backend: Box<dyn Backend>,
        integrations: Option<Integrations>,
        events: EventSink,
    ) -> Self {
        // The app may itself run in a Terminal Canvas terminal, whose variables name that terminal's
        // files, perhaps in another app. Each terminal sets its own, so none is inherited. Windows
        // matches names case-insensitively, so an inherited `Tc_Hook` would win over `TC_HOOK`.
        let windows = config.platform.is_windows();
        config.env.retain(|key, _| {
            !integration::ENV_KEYS
                .iter()
                .chain(&[tc_core::launch::CARD_ENV, CANVAS_ENV])
                .any(|ours| {
                    if windows {
                        key.eq_ignore_ascii_case(ours)
                    } else {
                        key == ours
                    }
                })
        });
        remove_cargo_launch(&mut config.env, windows);
        TerminalManager {
            config,
            backend,
            integrations,
            events,
            sessions: HashMap::new(),
            metadata: HashMap::new(),
            stopping: Vec::new(),
            generation: 0,
            outbox: Vec::new(),
            integration_failing: false,
            keeper: None,
            tmux_watch: None,
        }
    }

    /// The environment new shells inherit, before each terminal's own variables.
    pub fn environment(&self) -> &BTreeMap<String, String> {
        &self.config.env
    }

    /// Keeps terminals started from now on running after the app quits, or stops doing so. Running
    /// terminals keep how they started, and the tmux watch keeps reporting for tmux clients.
    pub fn set_keeper(&mut self, keeper: Option<Keeper>) {
        if let Some(Keeper::Tmux(tmux)) = &keeper
            && self.tmux_watch.is_none()
        {
            self.tmux_watch = Some(tmux::Watch::new(tmux.clone(), Arc::clone(&self.events)));
        }
        self.keeper = keeper;
    }

    pub fn keeper(&self) -> Option<&Keeper> {
        self.keeper.as_ref()
    }

    /// Events for the UI since the last call, in order.
    pub fn take_events(&mut self) -> Vec<TerminalEvent> {
        std::mem::take(&mut self.outbox)
    }

    pub fn running(&self) -> usize {
        self.sessions.len()
    }

    pub fn is_running(&self, id: &str) -> bool {
        self.sessions.contains_key(id)
    }

    /// The generation and actual PTY dimensions, for additional views of a desktop terminal.
    pub fn view(&self, id: &str) -> Option<(u64, u16, u16)> {
        self.sessions.get(id).map(|s| (s.generation, s.size.0, s.size.1))
    }

    pub fn process_id(&self, id: &str) -> Option<u32> {
        self.sessions.get(id)?.process.pid()
    }

    /// Unacknowledged output of a running terminal, in UTF-16 units.
    pub fn pending_output(&self, id: &str) -> Option<usize> {
        self.sessions.get(id).map(|session| session.pending)
    }

    /// The live directory a terminal last reported (outer `None` before any report).
    pub fn live_directory(&self, id: &str) -> Option<Option<String>> {
        self.sessions.get(id).and_then(|session| session.cwd.clone())
    }

    /// Whether a running terminal started with integration; without it, its AI session is not saved
    /// and programs in it cannot open terminals. `None` when it is not running.
    pub fn integrated(&self, id: &str) -> Option<bool> {
        self.sessions.get(id).map(|session| session.integration.is_some())
    }

    fn emit(&mut self, event: TerminalEvent) {
        self.outbox.push(event);
    }

    fn current(&mut self, key: &SessionKey) -> Option<&mut Session> {
        self.sessions
            .get_mut(&key.id)
            .filter(|session| session.generation == key.generation)
    }

    /// Starts a card's terminal. `mode` is `start` (run the card's command), `resume` (resume its
    /// saved AI session), or `fresh` (a plain shell, falling back to the home folder). Absent
    /// values take the JavaScript defaults: 80 columns, 24 rows, `start`.
    pub fn start(
        &mut self,
        raw: &Value,
        cols: Option<&Value>,
        rows: Option<&Value>,
        mode: Option<&Value>,
    ) -> Result<Started> {
        let card = validate_card(raw, VERSION)?;
        let mode = match mode {
            None => "start",
            Some(Value::String(mode)) if matches!(mode.as_str(), "start" | "resume" | "fresh") => mode.as_str(),
            _ => return invalid("Unknown terminal start mode."),
        };
        if mode == "resume" && card.session.is_none() {
            return invalid("No valid saved session ID. Start a fresh shell instead.");
        }
        let (cols, rows) = dimensions(cols.unwrap_or(&Value::from(80)), rows.unwrap_or(&Value::from(24)))?;
        if self.sessions.contains_key(&card.id) {
            return invalid("This terminal is already running.");
        }
        let keeper = self.keeper.clone();
        // A card whose terminal is still kept running attaches to it; a fresh shell replaces it.
        if let Some(keeper) = &keeper
            && let Some(integration) = keeper.find(&card.id)
        {
            if mode != "fresh" {
                let homes = self.name_homes(&self.config.env);
                return self.attach(keeper, &card, cols, rows, integration, homes, None);
            }
            keeper.kill_session(&card.id);
        }
        self.spawn_card(&card, (cols, rows), mode, keeper)
    }

    fn spawn_card(
        &mut self,
        card: &Card,
        (cols, rows): (u16, u16),
        mode: &str,
        keeper: Option<Keeper>,
    ) -> Result<Started> {
        let platform = self.config.platform;
        let windows = platform.is_windows();
        let saved = match (mode, &card.session) {
            ("resume", Some(session)) => &session.cwd,
            _ => &card.cwd,
        };
        let mut cwd = if saved.is_empty() {
            self.config.home.clone()
        } else {
            saved.clone()
        };
        if !is_directory(&cwd) {
            if !matches!(mode, "fresh" | "recover") {
                return invalid("Working directory is unavailable. Start a fresh shell to use your home folder.");
            }
            cwd.clone_from(&self.config.home);
        }
        let env_value = |key: &str| self.config.env.get(key).filter(|value| !value.is_empty());
        let mut shell = if windows {
            let root = env_value("SystemRoot")
                .map_or("C:\\Windows", String::as_str)
                .replace('/', "\\");
            format!(
                "{}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
                root.trim_end_matches('\\')
            )
        } else {
            env_value("SHELL").map_or("/bin/bash", String::as_str).to_owned()
        };
        let mut command = match (mode, &card.session) {
            ("fresh", _) => String::new(),
            ("recover", _) if !windows || !is_shell_launcher(trim(&card.command)) => String::new(),
            ("resume", Some(session)) => match session.provider {
                Provider::Codex => format!("codex resume {}", session.session_id),
                Provider::Claude => format!("claude --resume {}", session.session_id),
            },
            _ => card.command.clone(),
        };
        // Integrate explicit shell launchers directly, preserving their selected shell.
        let mut recovery_card = card.clone();
        if windows && is_shell_launcher(trim(&command)) {
            let launcher = trim(&command);
            shell = if launcher.to_ascii_lowercase().ends_with(".exe") {
                launcher.to_owned()
            } else {
                format!("{launcher}.exe")
            };
            recovery_card.command.clone_from(&shell);
            command.clear();
        } else {
            recovery_card.command.clear();
        }
        // The account folder is created on first use, so a card keeps its account even when the
        // folder was removed; Claude Code then asks to sign in again.
        let account_folder = match (&card.claude_account, &self.config.claude_accounts) {
            (Some(name), Some(root)) => {
                let folder = tc_core::accounts::folder(root, name);
                if let Err(error) = fs::create_dir_all(&folder) {
                    return Err(Error::Invalid(format!(
                        "Could not prepare the Claude account \"{name}\": {error}"
                    )));
                }
                Some(folder)
            }
            _ => None,
        };
        // Integration adds AI session capture, folder reports, and the launch request inbox. A
        // terminal whose integration files cannot be written still starts without them, and says so.
        let mut failure = None;
        let integration = match &mut self.integrations {
            Some(prepare) => prepare(&shell, platform).unwrap_or_else(|error| {
                failure = Some(error);
                None
            }),
            None => None,
        };
        if failure.is_none() {
            self.integration_failing = false;
        }
        let args = match integration.as_ref().and_then(|integration| integration.args.clone()) {
            Some(args) => args,
            None if windows && is_bare_cmd(&shell) => Vec::new(),
            None if windows => powershell_args(POWERSHELL_BOOTSTRAP),
            None => vec!["-l".to_owned()],
        };
        let mut env = self.config.env.clone();
        env.extend(
            integration
                .iter()
                .flat_map(|integration| integration.env.iter().cloned()),
        );
        env.insert("TERM".into(), "xterm-256color".into());
        env.insert("COLORTERM".into(), "truecolor".into());
        env.insert(CANVAS_ENV.into(), "1".into());
        // Lets a program outside this terminal name it as the parent of a new terminal.
        env.insert(tc_core::launch::CARD_ENV.into(), card.id.clone());
        env.remove("ELECTRON_RUN_AS_NODE");
        if let Some(folder) = account_folder {
            // Windows matches names case-insensitively, so an inherited `Claude_Config_Dir` goes too.
            env.retain(|key, _| {
                !(key == tc_core::accounts::ENV || windows && key.eq_ignore_ascii_case(tc_core::accounts::ENV))
            });
            env.insert(tc_core::accounts::ENV.into(), folder.to_string_lossy().into_owned());
        }
        if windows {
            let prompt = env
                .get("PROMPT")
                .filter(|prompt| !prompt.is_empty())
                .map_or("$P$G", String::as_str);
            let prompt = format!("$E]9;9;$P$E\\{prompt}");
            env.insert("PROMPT".into(), prompt);
        }
        if let Some(keeper) = keeper {
            return self.start_kept(
                &keeper,
                &recovery_card,
                KeptStart {
                    shell,
                    args,
                    cwd,
                    cols,
                    rows,
                    env,
                    integration,
                    failure,
                    command,
                },
            );
        }
        self.generation += 1;
        let key = SessionKey {
            id: card.id.clone(),
            generation: self.generation,
        };
        let request = SpawnRequest {
            shell: shell.clone(),
            args,
            cwd: cwd.clone(),
            cols,
            rows,
            env,
        };
        let process = match self.backend.spawn(&request, key.clone(), Arc::clone(&self.events)) {
            Ok(process) => process,
            Err(error) => {
                if let Some(integration) = &integration {
                    integration.cleanup();
                }
                return Err(error.into());
            }
        };
        let pid = process.pid();
        let initial_command = integration.as_ref().and_then(|integration| integration.command.clone());
        let name_homes = self.name_homes(&request.env);
        let session = Session {
            card: recovery_card,
            retry_after: None,
            name_session: None,
            name_homes,
            size: (cols, rows),
            generation: key.generation,
            process,
            integration,
            cwd: None,
            ready: false,
            pending: 0,
            paused: false,
            parser: MetadataParser::new(cwd.clone(), platform, false),
            reports: DirectoryReports::new(platform, &self.config.hostname),
            launch: None,
            watch: None,
            keeper: None,
        };
        self.sessions.insert(card.id.clone(), session);
        let metadata = CardMetadata {
            cwd,
            session: card.session.clone(),
        };
        self.metadata.insert(card.id.clone(), metadata.clone());
        self.emit(TerminalEvent::Metadata {
            id: card.id.clone(),
            metadata,
            initial: true,
        });
        if let Some(error) = failure
            && !std::mem::replace(&mut self.integration_failing, true)
        {
            self.emit(TerminalEvent::Error {
                id: card.id.clone(),
                message: integration_warning(&error),
            });
        }
        if !windows && let Some(pid) = pid {
            let watch = self
                .backend
                .watch_directory(pid, platform, key.clone(), Arc::clone(&self.events));
            if let Some(session) = self.current(&key) {
                session.watch = Some(watch);
            }
        }
        let typed = initial_command
            .into_iter()
            .chain((!command.is_empty()).then_some(command));
        for line in typed {
            if let Err(error) = self.write(&card.id, &format!("{line}\r")) {
                self.stop(&card.id);
                return Err(error);
            }
        }
        Ok(Started {
            id: card.id.clone(),
            pid,
            shell,
            metadata: self.metadata[&card.id].clone(),
            kept: false,
        })
    }

    /// Where Claude Code and Codex keep their sessions for a shell with `env`, for naming.
    fn name_homes(&self, env: &BTreeMap<String, String>) -> [std::path::PathBuf; 2] {
        let windows = self.config.platform.is_windows();
        [("CLAUDE_CONFIG_DIR", ".claude"), ("CODEX_HOME", ".codex")].map(|(name, default)| {
            env.iter()
                .find(|(key, value)| !value.is_empty() && (*key == name || windows && key.eq_ignore_ascii_case(name)))
                .map(|(_, value)| std::path::PathBuf::from(value))
                .unwrap_or_else(|| std::path::PathBuf::from(&self.config.home).join(default))
        })
    }

    /// Starts the card's shell kept running, and attaches to it.
    fn start_kept(&mut self, keeper: &Keeper, card: &Card, start: KeptStart) -> Result<Started> {
        let KeptStart {
            shell,
            args,
            cwd,
            cols,
            rows,
            env,
            integration,
            failure,
            command,
        } = start;
        let initial_command = integration.as_ref().and_then(|integration| integration.command.clone());
        let homes = self.name_homes(&env);
        let mut fresh = card.clone();
        fresh.cwd.clone_from(&cwd);
        let leftover = integration.clone();
        let started = match keeper {
            Keeper::Tmux(tmux) => {
                // The pane gets what this terminal adds to the shared environment; tmux sets its own TERM.
                let added: Vec<(String, String)> = env
                    .iter()
                    .filter(|(key, value)| *key != "TERM" && self.config.env.get(*key) != Some(*value))
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect();
                tmux.new_session(&tmux::NewSession {
                    card: &card.id,
                    cwd: &cwd,
                    cols,
                    rows,
                    shell: &shell,
                    args: &args,
                    env: &added,
                    integration: integration.as_ref(),
                })
                .map_err(Error::from)
                .and_then(|()| {
                    self.attach(keeper, &fresh, cols, rows, integration, homes, None)
                        .inspect_err(|_| tmux.kill_session(&card.id))
                })
            }
            Keeper::Daemon(_) => {
                let request = SpawnRequest {
                    shell,
                    args,
                    cwd,
                    cols,
                    rows,
                    env,
                };
                self.attach(keeper, &fresh, cols, rows, integration, homes, Some(request))
            }
        };
        let started = match started {
            Ok(started) => started,
            Err(error) => {
                if let Some(integration) = &leftover {
                    integration.cleanup();
                }
                return Err(error);
            }
        };
        if let Some(error) = failure
            && !std::mem::replace(&mut self.integration_failing, true)
        {
            self.emit(TerminalEvent::Error {
                id: card.id.clone(),
                message: integration_warning(&error),
            });
        }
        let typed = initial_command
            .into_iter()
            .chain((!command.is_empty()).then_some(command));
        for line in typed {
            if let Err(error) = self.write(&card.id, &format!("{line}\r")) {
                self.stop(&card.id);
                return Err(error);
            }
        }
        Ok(started)
    }

    /// Attaches to the card's kept terminal: a tmux client in a PTY, or a connection to the helper.
    /// With `new`, the helper first starts that terminal.
    #[allow(clippy::too_many_arguments)]
    fn attach(
        &mut self,
        keeper: &Keeper,
        card: &Card,
        cols: u16,
        rows: u16,
        integration: Option<Integration>,
        name_homes: [std::path::PathBuf; 2],
        new: Option<SpawnRequest>,
    ) -> Result<Started> {
        let platform = self.config.platform;
        // The folder shown until the shell reports one; a tmux client also starts there, so it must exist.
        let known = self.metadata.get(&card.id).map(|metadata| metadata.cwd.clone());
        let cwd = [
            known.as_deref(),
            Some(card.cwd.as_str()),
            Some(self.config.home.as_str()),
        ]
        .into_iter()
        .flatten()
        .find(|cwd| !cwd.is_empty() && is_directory(cwd))
        .unwrap_or(&self.config.home)
        .to_owned();
        self.generation += 1;
        let key = SessionKey {
            id: card.id.clone(),
            generation: self.generation,
        };
        let events = Arc::clone(&self.events);
        let (process, shell) = match (keeper, new) {
            (Keeper::Tmux(tmux), _) => {
                let (program, args) = tmux.attach(&card.id);
                let mut env = self.config.env.clone();
                env.insert("TERM".into(), "xterm-256color".into());
                env.insert("COLORTERM".into(), "truecolor".into());
                env.remove("ELECTRON_RUN_AS_NODE");
                // An app started inside tmux would otherwise refuse to nest the client.
                env.remove("TMUX");
                let request = SpawnRequest {
                    shell: program.clone(),
                    args,
                    cwd: cwd.clone(),
                    cols,
                    rows,
                    env,
                };
                (self.backend.spawn(&request, key.clone(), events)?, program)
            }
            (Keeper::Daemon(daemon), Some(request)) => {
                let attached = daemon.create(&card.id, &request, integration.as_ref(), key.clone(), events)?;
                (attached.process, attached.shell)
            }
            (Keeper::Daemon(daemon), None) => {
                let attached = daemon.attach(&card.id, cols, rows, key.clone(), events)?;
                (attached.process, attached.shell)
            }
        };
        let pid = process.pid();
        let mut recovery_card = card.clone();
        if let Keeper::Daemon(_) = keeper {
            recovery_card.command.clear();
            if platform.is_windows() && is_shell_launcher(&shell) {
                recovery_card.command.clone_from(&shell);
            }
        }
        let session = Session {
            card: recovery_card,
            retry_after: None,
            name_session: None,
            name_homes,
            size: (cols, rows),
            generation: key.generation,
            process,
            integration,
            cwd: None,
            ready: false,
            pending: 0,
            paused: false,
            parser: MetadataParser::new(cwd.clone(), platform, false),
            reports: DirectoryReports::new(platform, &self.config.hostname),
            launch: None,
            watch: None,
            keeper: Some(keeper.clone()),
        };
        self.sessions.insert(card.id.clone(), session);
        if let (Keeper::Tmux(_), Some(watch)) = (keeper, &self.tmux_watch) {
            watch.add(key);
        }
        let metadata = CardMetadata {
            cwd,
            session: card.session.clone(),
        };
        self.metadata.insert(card.id.clone(), metadata.clone());
        self.emit(TerminalEvent::Metadata {
            id: card.id.clone(),
            metadata: metadata.clone(),
            initial: true,
        });
        Ok(Started {
            id: card.id.clone(),
            pid,
            shell,
            metadata,
            kept: true,
        })
    }

    /// Handles a report from a terminal's threads.
    pub fn handle(&mut self, key: SessionKey, event: SessionEvent) {
        match event {
            SessionEvent::Output(data) => self.output(&key, data),
            SessionEvent::Exit(status) => self.exit(&key, status, true),
            SessionEvent::Superseded => self.exit(&key, ExitStatus { code: 1, signal: None }, false),
            SessionEvent::Directory(cwd) => self.report_directory(&key, cwd),
            SessionEvent::Report(text) => self.report(&key, &text),
        }
    }

    /// Integration reports from tmux: parsed like output, never shown.
    fn report(&mut self, key: &SessionKey, text: &str) {
        let Some(session) = self.current(key) else { return };
        let mut parsed = Vec::new();
        session.parser.feed(text, &mut |event| parsed.push(event));
        let mut reports = Vec::new();
        session.reports.feed(text, |report| reports.push(report));
        for event in parsed {
            self.metadata_event(key, event);
        }
        for report in reports {
            if let Report::Cwd(cwd) = report {
                self.report_directory(key, cwd);
            }
        }
    }

    fn output(&mut self, key: &SessionKey, data: String) {
        let Some(session) = self.current(key) else { return };
        let mut parsed = Vec::new();
        session.parser.feed(&data, &mut |event| parsed.push(event));
        for event in parsed {
            self.metadata_event(key, event);
        }
        let Some(session) = self.current(key) else { return };
        session.pending += utf16_len(&data);
        if session.pending > HIGH_WATER && !session.paused {
            session.paused = true;
            session.process.pause();
        }
        let mut reports = Vec::new();
        session.reports.feed(&data, |report| reports.push(report));
        self.emit(TerminalEvent::Data {
            id: key.id.clone(),
            data,
        });
        for report in reports {
            match report {
                Report::Cwd(cwd) => self.report_directory(key, cwd),
                Report::Ready(ready) => {
                    if let Some(session) = self.current(key) {
                        session.ready = ready;
                    }
                }
            }
        }
    }

    fn metadata_event(&mut self, key: &SessionKey, event: MetadataEvent) {
        match event {
            MetadataEvent::Change(patch) => self.update_metadata(&key.id, patch),
            MetadataEvent::Launch(event) => {
                let provider = event.get("provider").and_then(Value::as_str).and_then(Provider::parse);
                let token = match event.get("token") {
                    Some(Value::String(token)) => LaunchToken::Text(token.clone()),
                    _ => LaunchToken::Unmatchable,
                };
                if let (Some(session), Some(provider)) = (self.current(key), provider) {
                    session.name_session = None;
                    session.launch = Some(Launch { provider, token });
                }
            }
            MetadataEvent::Warning(message) => self.emit(TerminalEvent::Error {
                id: key.id.clone(),
                message,
            }),
            MetadataEvent::End(event) => {
                let matches = self
                    .current(key)
                    .and_then(|session| session.launch.as_ref())
                    .is_some_and(|launch| launch.token.matches(event.get("token")));
                if !matches {
                    return;
                }
                self.poll_metadata(&key.id);
                if truthy(event.get("exitCode")) {
                    self.emit(TerminalEvent::Error {
                        id: key.id.clone(),
                        message: "The AI tool exited with an error. See the terminal for details; the saved ID is retained. You can stop this terminal and retry Resume or open a fresh shell.".to_owned(),
                    });
                }
            }
        }
    }

    /// Unknown live locations change the label, while the last usable folder stays available for
    /// restoration and shutdown persistence.
    fn report_directory(&mut self, key: &SessionKey, cwd: Option<String>) {
        let Some(session) = self.current(key) else { return };
        if session.cwd.as_ref() == Some(&cwd) {
            return;
        }
        session.cwd = Some(cwd.clone());
        if let Some(cwd) = &cwd {
            session.parser.cwd.clone_from(cwd);
            self.update_metadata(
                &key.id,
                MetadataPatch {
                    cwd: Some(cwd.clone()),
                    session: None,
                },
            );
        }
        self.emit(TerminalEvent::Cwd {
            id: key.id.clone(),
            cwd,
        });
    }

    fn exit(&mut self, key: &SessionKey, status: ExitStatus, recover: bool) {
        if let Some(index) = self.stopping.iter().position(|stopping| stopping.key == *key) {
            self.stopping.remove(index);
        }
        if self.current(key).is_none() {
            return;
        }
        self.poll_metadata(&key.id);
        // A request made just before the shell ended still opens its terminal.
        self.poll_launches(&key.id);
        let finish = self.finish_code(&key.id);
        let Some(mut session) = self.sessions.remove(&key.id) else {
            return;
        };
        if let Some(code) = finish {
            self.release(&key.id, session, true);
            self.emit(TerminalEvent::Exit {
                id: key.id.clone(),
                status: ExitStatus {
                    code: i64::from(code),
                    signal: None,
                },
            });
            return;
        }
        let keeper = session.keeper.clone();
        let retry = recover && session.retry_after.is_none_or(|after| Instant::now() >= after);
        let existing = keeper
            .as_ref()
            .filter(|_| retry)
            .and_then(|keeper| keeper.find(&key.id));
        let (cols, rows) = session.size;
        let mut card = session.card.clone();
        if let Some(metadata) = self.metadata.get(&key.id) {
            card.cwd.clone_from(&metadata.cwd);
            card.session.clone_from(&metadata.session);
        }
        if let (true, Some(keeper), Some(integration)) = (retry, &keeper, existing) {
            self.unwatch(&key.id, Some(keeper));
            let (launch, parser, name_session, name_homes) = (
                session.launch.take(),
                session.parser.clone(),
                session.name_session.take(),
                session.name_homes.clone(),
            );
            drop(session); // The kept shell still owns its integration files.
            match self.attach(keeper, &card, cols, rows, integration, name_homes, None) {
                Ok(_) => {
                    let restored = self.sessions.get_mut(&key.id).expect("reattached session");
                    restored.launch = launch;
                    restored.parser = parser;
                    restored.name_session = name_session;
                    self.recovered(&key.id, None);
                    return;
                }
                Err(error) => self.recovery_error(&key.id, error),
            }
        } else if !retry {
            self.release(&key.id, session, false);
        } else {
            self.unwatch(&key.id, keeper.as_ref());
            dispose(session);
            match self.spawn_card(&card, (cols, rows), "recover", keeper) {
                Ok(_) => {
                    self.recovered(&key.id, Some(status));
                    return;
                }
                Err(error) => self.recovery_error(&key.id, error),
            }
        }
        self.emit(TerminalEvent::Exit {
            id: key.id.clone(),
            status,
        });
    }

    fn recovered(&mut self, id: &str, previous_exit: Option<ExitStatus>) {
        self.sessions.get_mut(id).expect("recovered session").retry_after =
            Some(Instant::now() + Duration::from_secs(10));
        self.emit(TerminalEvent::Recovered {
            id: id.to_owned(),
            previous_exit,
        });
    }

    fn recovery_error(&mut self, id: &str, error: Error) {
        self.emit(TerminalEvent::Error {
            id: id.to_owned(),
            message: format!("Could not recover the terminal: {error}"),
        });
    }

    /// A launch without an ID must not replace a known conversation with a guess.
    fn update_metadata(&mut self, id: &str, patch: MetadataPatch) {
        if let Some(Some(metadata)) = &patch.session
            && let Some(session) = self.sessions.get_mut(id)
            && session
                .parser
                .launch()
                .is_some_and(|launch| launch.provider == metadata.provider)
        {
            session.name_session = Some(metadata.clone());
        }
        let Some(previous) = self.metadata.get(id) else { return };
        let next = CardMetadata {
            cwd: patch.cwd.unwrap_or_else(|| previous.cwd.clone()),
            session: patch.session.flatten().or_else(|| previous.session.clone()),
        };
        if next == *previous {
            return;
        }
        self.metadata.insert(id.to_owned(), next.clone());
        self.emit(TerminalEvent::Metadata {
            id: id.to_owned(),
            metadata: next,
            initial: false,
        });
    }

    /// Reads the session a provider hook recorded for the current launch, if any.
    fn poll_metadata(&mut self, id: &str) {
        let Some(session) = self.sessions.get(id) else { return };
        let (Some(integration), Some(launch)) = (&session.integration, &session.launch) else {
            return;
        };
        let file = &integration.session_file;
        if fs::metadata(file).map_or(true, |metadata| metadata.len() > SESSION_FILE_LIMIT) {
            return;
        }
        let Ok(text) = fs::read_to_string(file) else { return };
        let Ok(raw) = serde_json::from_str::<Value>(&text) else {
            return;
        };
        let Some(found) = session_metadata(&raw) else { return };
        if launch.token.matches(raw.get("token")) && found.provider == launch.provider {
            self.update_metadata(
                id,
                MetadataPatch {
                    cwd: None,
                    session: Some(Some(found)),
                },
            );
        }
    }

    /// Checks every integrated terminal's session file and launch requests. Call every
    /// [`HOOK_POLL_INTERVAL`].
    pub fn poll_hooks(&mut self) {
        let ids: Vec<String> = self.sessions.keys().cloned().collect();
        for id in ids {
            self.poll_metadata(&id);
            self.poll_launches(&id);
            if let Some(code) = self.finish_code(&id) {
                self.stop(&id);
                self.emit(TerminalEvent::Exit {
                    id,
                    status: ExitStatus {
                        code: i64::from(code),
                        signal: None,
                    },
                });
            }
        }
    }

    fn finish_code(&self, id: &str) -> Option<i32> {
        take_finish(self.sessions.get(id)?.integration.as_ref()?.launch_dir.as_deref()?)
    }

    /// A name belongs to this particular CLI launch, not merely a saved session on the card.
    pub fn name_request(&self, id: &str) -> Option<crate::titles::NameRequest> {
        let running = self.sessions.get(id)?;
        let launch = running.parser.launch()?;
        let LaunchToken::Text(token) = &launch.token else {
            return None;
        };
        let session = running.name_session.as_ref()?;
        if session.provider != launch.provider {
            return None;
        }
        Some(crate::titles::NameRequest {
            launch_token: token.clone(),
            key: SessionKey {
                id: id.to_owned(),
                generation: running.generation,
            },
            session: session.clone(),
            home: running.name_homes[usize::from(session.provider == Provider::Codex)].clone(),
        })
    }

    /// Takes the terminal's pending launch requests. A refused request is reported on the
    /// requesting terminal; an accepted one becomes a [`TerminalEvent::Launch`].
    fn poll_launches(&mut self, id: &str) {
        let Some(inbox) = self
            .sessions
            .get(id)
            .and_then(|session| session.integration.as_ref())
            .and_then(|integration| integration.launch_dir.clone())
        else {
            return;
        };
        for taken in take_requests(&inbox, self.config.platform) {
            let request = taken.request.and_then(|request| {
                if is_directory(&request.cwd) {
                    Ok(request)
                } else {
                    Err(Error::Invalid("Working directory is unavailable.".into()))
                }
            });
            let event = match (request, taken.id) {
                (Ok(request), Some(request_id)) => TerminalEvent::Launch {
                    id: id.to_owned(),
                    request_id,
                    inbox: inbox.clone(),
                    request,
                },
                (request, request_id) => {
                    let error = request.err().map_or_else(String::new, |error| error.to_string());
                    if let Some(request_id) = request_id {
                        write_result(
                            &inbox,
                            &request_id,
                            &serde_json::json!({ "status": "refused", "error": error }),
                        );
                    }
                    TerminalEvent::Error {
                        id: id.to_owned(),
                        message: format!("Could not open the requested terminal: {error}"),
                    }
                }
            };
            self.emit(event);
        }
    }

    /// Polls every hook and returns what to save for each card.
    pub fn snapshot(&mut self) -> &HashMap<String, CardMetadata> {
        self.poll_hooks();
        &self.metadata
    }

    /// Forgets metadata of stopped cards, for a new or opened workspace.
    pub fn forget(&mut self) {
        self.metadata.clear();
    }

    /// The folder a duplicate of `raw` should start in. On Windows the integration's last report
    /// counts only while the shell is idle at a prompt; elsewhere the shell process is asked.
    pub fn directory(&mut self, raw: &Value) -> Result<DirectoryRequest> {
        let card = validate_card(raw, VERSION)?;
        let Some(session) = self.sessions.get(&card.id) else {
            return Ok(DirectoryRequest::Ready(self.choose_directory(None, &card.cwd)));
        };
        let platform = self.config.platform;
        if platform.is_windows() {
            // tmux does not pass on the prompt's idle reports; its directory comes from tmux itself.
            let current = if session.ready || matches!(session.keeper, Some(Keeper::Tmux(_))) {
                session.cwd.clone().flatten()
            } else {
                None
            };
            return Ok(DirectoryRequest::Ready(self.choose_directory(current, &card.cwd)));
        }
        match session.process.pid() {
            Some(pid) => Ok(DirectoryRequest::Lookup(PendingLookup {
                pid,
                platform,
                key: SessionKey {
                    id: card.id.clone(),
                    generation: session.generation,
                },
                card_cwd: card.cwd,
            })),
            None => Ok(DirectoryRequest::Ready(self.choose_directory(None, &card.cwd))),
        }
    }

    /// Completes a [`DirectoryRequest::Lookup`]. A result for a terminal that stopped or restarted
    /// in the meantime is discarded.
    pub fn finish_directory(&mut self, lookup: PendingLookup, current: Option<String>) -> DirectoryChoice {
        let current = if self.current(&lookup.key).is_some() {
            current
        } else {
            None
        };
        self.choose_directory(current, &lookup.card_cwd)
    }

    fn choose_directory(&self, current: Option<String>, card_cwd: &str) -> DirectoryChoice {
        if let Some(current) = current
            .as_deref()
            .filter(|current| tc_core::dirs::is_directory(current))
        {
            return DirectoryChoice {
                cwd: current.to_owned(),
                warning: None,
            };
        }
        let cwd = tc_core::dirs::fallback_directory([
            Some(card_cwd),
            Some(self.config.home.as_str()),
            Some(self.config.process_cwd.as_str()),
        ]);
        let reason = if current.is_some_and(|current| !current.is_empty()) {
            "The current directory is no longer available."
        } else {
            "The current directory could not be determined. The terminal may be busy, stopped, or using a shell without directory reporting."
        };
        DirectoryChoice {
            cwd,
            warning: Some(format!(
                "{reason} Review the suggested folder before starting a new shell."
            )),
        }
    }

    /// Sends input to a terminal. A line break means the shell is no longer idle at its prompt.
    pub fn write(&mut self, id: &str, data: &str) -> Result<()> {
        if utf16_len(data) > MAX_INPUT_UNITS {
            return invalid("Input exceeds 64 KB.");
        }
        let Some(session) = self.sessions.get_mut(id) else {
            return Ok(());
        };
        // Keep the displayed path, but require a fresh idle prompt before duplicating.
        if data.contains(['\r', '\n']) {
            session.ready = false;
        }
        session.process.write(data).map_err(Error::from)
    }

    pub fn resize(&mut self, id: &str, cols: &Value, rows: &Value) -> Result<()> {
        let (cols, rows) = dimensions(cols, rows)?;
        match self.sessions.get_mut(id) {
            Some(session) => {
                session.process.resize(cols, rows)?;
                session.size = (cols, rows);
                Ok(())
            }
            None => Ok(()),
        }
    }

    /// The UI has written `amount` UTF-16 units of output. Invalid amounts are ignored.
    pub fn acknowledge(&mut self, id: &str, amount: &Value) {
        let Some(session) = self.sessions.get_mut(id) else {
            return;
        };
        let Some(amount) = integer(amount).filter(|amount| (0.0..=ACK_LIMIT).contains(amount)) else {
            return;
        };
        session.pending = session.pending.saturating_sub(amount as usize);
        session.process.acknowledge(amount as usize);
        if session.paused && session.pending < LOW_WATER {
            session.paused = false;
            session.process.resume();
        }
    }

    /// Stops a terminal, ending its kept terminal too.
    pub fn stop(&mut self, id: &str) {
        self.end(id, STOP_TIMEOUT, true);
    }

    /// Kills a terminal and tracks its exit for up to `timeout`, even when Stop or a workspace
    /// switch comes before quitting. A kept terminal keeps running.
    pub fn stop_within(&mut self, id: &str, timeout: Duration) {
        self.end(id, timeout, false);
    }

    fn end(&mut self, id: &str, timeout: Duration, end_kept: bool) {
        if !self.sessions.contains_key(id) {
            return;
        }
        self.poll_metadata(id);
        let Some(session) = self.sessions.remove(id) else {
            return;
        };
        let key = SessionKey {
            id: id.to_owned(),
            generation: session.generation,
        };
        let mut process = self.release(id, session, end_kept);
        process.kill();
        self.stopping.push(Stopping {
            key,
            deadline: Instant::now() + timeout,
            _process: process,
        });
    }

    /// Stops every terminal. Kept terminals keep running, to attach to later.
    pub fn stop_all(&mut self) {
        let ids: Vec<String> = self.sessions.keys().cloned().collect();
        for id in ids {
            self.stop_within(&id, STOP_TIMEOUT);
        }
    }

    /// Stops watching a terminal and returns its process. Integration files stay while the
    /// terminal is kept running, unless `end_kept` ends it.
    fn release(&self, id: &str, session: Session, end_kept: bool) -> Box<dyn Process> {
        self.unwatch(id, session.keeper.as_ref());
        if let Some(keeper) = &session.keeper {
            if end_kept {
                keeper.kill_session(id);
            } else if keeper.has_session(id) {
                drop(session.watch);
                return session.process;
            }
        }
        dispose(session)
    }

    fn unwatch(&self, id: &str, keeper: Option<&Keeper>) {
        if let (Some(Keeper::Tmux(_)), Some(watch)) = (keeper, &self.tmux_watch) {
            watch.remove(id);
        }
    }

    /// Stops every terminal. The host then keeps handling events until [`Self::stopping`] is zero,
    /// so native PTY cleanup finishes before the process exits.
    pub fn begin_shutdown(&mut self, timeout: Duration) {
        let ids: Vec<String> = self.sessions.keys().cloned().collect();
        for id in ids {
            self.stop_within(&id, timeout);
        }
    }

    /// Killed terminals that have neither exited nor timed out.
    pub fn stopping(&mut self) -> usize {
        let now = Instant::now();
        self.stopping.retain(|stopping| stopping.deadline > now);
        self.stopping.len()
    }

    /// When the next stop times out, for the host's shutdown wait.
    pub fn next_stop_deadline(&self) -> Option<Instant> {
        self.stopping.iter().map(|stopping| stopping.deadline).min()
    }
}

/// What [`TerminalManager::start`] prepared for a terminal kept running.
struct KeptStart {
    shell: String,
    args: Vec<String>,
    cwd: String,
    cols: u16,
    rows: u16,
    env: BTreeMap<String, String>,
    integration: Option<Integration>,
    failure: Option<io::Error>,
    command: String,
}

/// Stops directory polling and removes integration files, returning the process.
fn dispose(session: Session) -> Box<dyn Process> {
    drop(session.watch);
    if let Some(integration) = &session.integration {
        integration.cleanup();
    }
    session.process
}

impl Drop for TerminalManager {
    fn drop(&mut self) {
        self.stop_all();
    }
}
