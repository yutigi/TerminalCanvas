//! The desktop host's commands and lifecycle, from `src/main.cjs`.
//!
//! The JavaScript host relied on Node's event loop: each synchronous stretch between two `await`s
//! ran alone, so checks like `sessions.get(id) !== entry` held. One actor owns all mutable host
//! state and handles commands, terminal events, and poll ticks in order. Dialogs and other slow
//! operations run outside the actor; their continuations return through the same queue. Workspace writes and image tasks each run on a serial queue, entered
//! at the moment of the call, as the JavaScript promise chains were.
//!
//! Everything the OS provides (dialogs, the clipboard, the link opener, closing the window) goes
//! through [`Platform`], so the host can be tested without a window.

use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Map, Value, json};
use tc_core::assets::{
    IMAGE_BYTES, delete_assets, embed_assets, extract_assets, keep_list, store_image, unused_assets,
};
use tc_core::atomic::{self, Access};
use tc_core::js::utf16_len;
use tc_core::recovery::{CardMetadata, WorkspaceRecovery};
use tc_core::titles::{SettledTitle, TitleMode};
use tc_core::workspace::{PROFILES, Workspace, create_card, create_workspace, limits, validate_workspace};
use tc_core::{Error, Platform as Os};
use tc_pty::manager::{Backend, Config, DirectoryRequest, EventSink, Integrations, Keeper, STOP_TIMEOUT};
use tc_pty::{SessionEvent, SessionKey, TerminalEvent, TerminalManager};

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// The most text one copy or paste carries, in UTF-16 units. Copy and paste share it, so any
/// copied selection can be pasted back. The bridge sends a longer paste in ordered pieces, and
/// input typed afterward, Ctrl+C included, follows the whole paste. The limit bounds that wait,
/// and the unread paste held in memory, when a program reads its input slowly.
const CLIPBOARD_UNITS: usize = 1024 * 1024;

/// Shown at startup when the `tc-hook` sidecar is missing: without it, terminals have no
/// integration, so nothing in them can ask for a new terminal.
pub const HELPER_MISSING: &str = "Terminal Canvas could not find its helper, tc-hook, so AI sessions will not be saved and programs in terminals cannot open new ones. Reinstall Terminal Canvas (in a development build, run cargo build -p tc-hook), then restart it.";

/// Shown when keeping terminals running is turned on but tmux cannot be found (macOS and Linux).
pub const TMUX_MISSING: &str = "Keeping terminals running needs tmux, which was not found. Install it (for example with Homebrew or your package manager), or name it as \"tmuxProgram\" in settings.json in the app's data folder.";

/// Shown when keeping terminals running is turned on without the `tc-hook` helper (Windows).
pub const KEEPER_MISSING: &str = "Keeping terminals running needs Terminal Canvas's helper, tc-hook, which was not found. Reinstall Terminal Canvas (in a development build, run cargo build -p tc-hook), then try again.";

/// Added to the answer of a program whose new terminal started without integration, since it may
/// plan to save that terminal's AI session or open more terminals from it.
pub const NO_INTEGRATION: &str = "The new terminal started without Terminal Canvas integration (the app shows why), so its AI session will not be saved and programs in it cannot open terminals on the canvas.";

/// The file dialogs the host shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    /// `.terminalcanvas` files; opening also accepts `.json`.
    Workspace,
    Image,
}

/// What the host needs from the operating system.
pub trait Platform: Send + Sync + 'static {
    fn pick_folder(&self, default: Option<PathBuf>) -> BoxFuture<Option<PathBuf>>;
    fn save_file(&self, title: &'static str, file_name: String) -> BoxFuture<Option<PathBuf>>;
    fn open_file(&self, title: &'static str, kind: FileKind) -> BoxFuture<Option<PathBuf>>;
    fn read_clipboard(&self) -> BoxFuture<Result<String, String>>;
    fn write_clipboard(&self, text: String) -> BoxFuture<Result<(), String>>;
    fn open_link(&self, url: String) -> BoxFuture<Result<(), String>>;
    /// Finishes app exit. The host has already flushed and stopped every terminal.
    fn close_window(&self);
}

/// Where AI agents look for user-wide skills, for the agent setup (see [`tc_core::skills`]).
#[derive(Debug, Clone)]
pub struct AgentHome {
    /// The user's home folder.
    pub home: PathBuf,
    /// The `CLAUDE_CONFIG_DIR` shells inherit, if set.
    pub claude_config: Option<PathBuf>,
    /// Whether the first launch offers the setup.
    pub first_launch: bool,
}

/// Where the host keeps its files: the folder the Electron build used, so they carry over.
#[derive(Debug, Clone)]
pub struct Paths {
    pub data: PathBuf,
    /// The `tc-hook` sidecar. Without it, shells run without AI session capture.
    pub hook: Option<PathBuf>,
    /// Where the agent setup installs the skill. Without it, the setup is unavailable.
    pub agents: Option<AgentHome>,
    /// Detects tmux for the tmux setup. Without it (test builds), the setup is unavailable.
    pub tmux: Option<TmuxProbe>,
}

/// What the tmux setup knows about this machine (see [`tc_tmux::install`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TmuxState {
    pub installed: Option<tc_tmux::install::Installed>,
    /// How to install tmux here; `None` without a supported package manager.
    pub plan: Option<tc_tmux::install::Plan>,
}

/// Runs programs (`tmux -V`), so the host calls it off its async threads.
pub type TmuxProbe = fn() -> TmuxState;

/// This machine's tmux and the command that installs it.
pub fn detect_tmux() -> TmuxState {
    use tc_tmux::install::{Os, installed, plan};
    TmuxState {
        installed: installed(),
        plan: Os::current().and_then(|os| plan(os, tc_tmux::client::find_program)),
    }
}

impl TmuxState {
    fn usable(&self) -> bool {
        self.installed.as_ref().is_some_and(tc_tmux::install::Installed::usable)
    }

    fn to_json(&self) -> Value {
        let version = |v: tc_tmux::Version| format!("{}.{}", v.major, v.minor);
        json!({
            "installed": self.usable(),
            // Paths as text: one that is not Unicode is still shown, approximately.
            "path": self.installed.as_ref().map(|found| found.binary.display().to_string()),
            "version": self.installed.as_ref().and_then(|found| found.version).map(version),
            "minimum": version(tc_tmux::Version::MINIMUM),
            "manager": self.plan.as_ref().map(|plan| plan.manager),
            "command": self.plan.as_ref().map(|plan| plan.command.as_str()),
        })
    }
}

impl Paths {
    pub fn recovery(&self) -> PathBuf {
        self.data.join("workspace.terminalcanvas")
    }
    pub fn assets(&self) -> PathBuf {
        self.data.join("assets")
    }
    pub fn integration(&self) -> PathBuf {
        self.data.join("shell-integration")
    }
    /// One folder per Claude Code account (see [`tc_core::accounts`]).
    pub fn claude_accounts(&self) -> PathBuf {
        self.data.join(tc_core::accounts::DIR)
    }
    /// Where programs outside the canvas ask for new terminals (see [`tc_core::launch`]).
    pub fn launch_requests(&self) -> PathBuf {
        tc_core::launch::app_inbox(&self.data)
    }
    /// Present once the user has installed the skill or declined the first-launch offer.
    pub fn agent_setup(&self) -> PathBuf {
        self.data.join("agent-setup.json")
    }
    /// Present once the user has started the tmux install or declined the first-launch offer.
    pub fn tmux_setup(&self) -> PathBuf {
        self.data.join("tmux-setup.json")
    }
    /// App settings that belong to this machine rather than a workspace.
    pub fn settings(&self) -> PathBuf {
        self.data.join("settings.json")
    }
    /// Where the helper that keeps terminals running keeps its state (Windows).
    pub fn terminal_helper(&self) -> PathBuf {
        self.data.join("terminal-helper")
    }
}

/// Whether terminals keep running after the app quits: in the app's helper on Windows (see
/// [`tc_pty::daemon`]), in tmux sessions elsewhere (see [`tc_pty::tmux`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KeepRunning {
    pub enabled: bool,
    /// A tmux executable chosen by hand in the settings file; otherwise tmux is looked up.
    pub tmux_program: Option<PathBuf>,
}

impl KeepRunning {
    /// The saved setting. A missing or unreadable file means it is off.
    pub fn read(file: &Path) -> Self {
        let Ok(text) = std::fs::read_to_string(file) else {
            return KeepRunning::default();
        };
        let Ok(saved) = serde_json::from_str::<Value>(&text) else {
            return KeepRunning::default();
        };
        KeepRunning {
            enabled: saved.get("keepRunning") == Some(&Value::Bool(true)),
            tmux_program: saved
                .get("tmuxProgram")
                .and_then(Value::as_str)
                .filter(|program| !program.is_empty())
                .map(PathBuf::from),
        }
    }

    /// Saves the setting, keeping the file's other fields.
    pub fn write(&self, file: &Path) -> std::io::Result<()> {
        let mut saved = std::fs::read_to_string(file)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        saved["keepRunning"] = json!(self.enabled);
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        atomic::write(file, format!("{saved}\n").as_bytes(), Access::Default)
    }

    /// What would keep terminals running on this machine, whether or not the setting is on, or why
    /// nothing can.
    pub fn keeper(&self, paths: &Paths, env: &BTreeMap<String, String>, os: Os) -> Result<Keeper, &'static str> {
        if os.is_windows() {
            let hook = paths.hook.clone().ok_or(KEEPER_MISSING)?;
            return Ok(Keeper::Daemon(tc_pty::daemon::Daemon::new(
                hook,
                paths.terminal_helper(),
            )));
        }
        let program = tc_pty::tmux::find(self.tmux_program.as_deref(), env).ok_or(TMUX_MISSING)?;
        Ok(Keeper::Tmux(tc_pty::tmux::Tmux::new(program, env.clone())))
    }
}

/// Runs jobs one at a time, in the order they were queued.
struct SerialQueue(mpsc::Sender<Box<dyn FnOnce() + Send>>);

impl SerialQueue {
    fn new(name: &str) -> Self {
        let (sender, jobs) = mpsc::channel::<Box<dyn FnOnce() + Send>>();
        std::thread::Builder::new()
            .name(name.to_owned())
            .spawn(move || {
                for job in jobs {
                    job();
                }
            })
            .expect("queue thread starts");
        SerialQueue(sender)
    }

    /// Queues `job` now, without waiting for it.
    fn push(&self, job: impl FnOnce() + Send + 'static) {
        let _ = self.0.send(Box::new(job));
    }

    /// Queues `job` now and returns its result when it has run.
    fn run<T: Send + 'static>(&self, job: impl FnOnce() -> T + Send + 'static) -> BoxFuture<Option<T>> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let _ = self.0.send(Box::new(move || {
            let _ = sender.send(job());
        }));
        Box::pin(async move { receiver.await.ok() })
    }
}

/// Input that arrived out of order waits here until the missing pieces arrive. IPC calls are not
/// guaranteed to arrive in the order the renderer sent them.
#[derive(Default)]
struct InputOrder {
    next: u64,
    waiting: BTreeMap<u64, String>,
}

struct State {
    names: Naming,
    manager: TerminalManager,
    recovery: WorkspaceRecovery,
    filename: Option<PathBuf>,
    inputs: HashMap<String, InputOrder>,
    launches: crate::launches::Launches,
    pointers: crate::pointers::Pointers,
    mirror: Option<crate::remote_mirror::Mirror>,
}

#[derive(Default)]
struct Naming {
    epoch: u64,
    busy: bool,
    entries: HashMap<String, NameEntry>,
}

struct NameEntry {
    request: tc_pty::titles::NameRequest,
    revision: u64,
    next_read: std::time::Instant,
    settled: SettledTitle,
    origin: std::time::Instant,
}

/// Where events for the UI go.
pub type Events = Arc<dyn Fn(Value) + Send + Sync>;

type Task = Box<dyn FnOnce(&Host, &mut State) + Send>;

enum Message {
    Task(Task),
    Session(SessionKey, SessionEvent),
    Poll,
}

pub struct Host {
    state: tokio::sync::mpsc::UnboundedSender<Message>,
    platform: Arc<dyn Platform>,
    paths: Paths,
    os: Os,
    home: String,
    process_cwd: String,
    writes: SerialQueue,
    assets: SerialQueue,
    events: Mutex<Option<Events>>,
    remote_events: tokio::sync::broadcast::Sender<Value>,
    quitting: AtomicBool,
}

type CommandResult = Result<Value, String>;

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn field<'a>(payload: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    payload?.as_object()?.get(key)
}

/// Layout autosaves cannot create or re-arm automation. Only pointer-configure changes it.
fn pointer_snapshot(board: &Workspace, raw: &Value) -> Value {
    let mut raw = raw.clone();
    if let Some(fields) = raw.as_object_mut() {
        if board.hooks_paused {
            fields.insert("hooksPaused".into(), json!(true));
        } else {
            fields.remove("hooksPaused");
        }
        if let Some(items) = fields.get_mut("items").and_then(Value::as_array_mut) {
            for item in items {
                let hook = board
                    .items
                    .iter()
                    .find(|current| item["id"].as_str() == Some(&current.id))
                    .and_then(|current| current.hook.as_ref());
                if let Some(fields) = item.as_object_mut() {
                    if let Some(hook) = hook {
                        fields.insert("hook".into(), json!(hook));
                    } else {
                        fields.remove("hook");
                    }
                }
            }
        }
    }
    raw
}

/// `name.replace(/[^\w -]/g, '') || 'Workspace'`
fn file_stem(name: &str) -> String {
    let kept: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | ' ' | '-'))
        .collect();
    if kept.is_empty() { "Workspace".to_owned() } else { kept }
}

/// Terminal output is untrusted: links are validated again here, at the OS boundary, even though
/// xterm only offers HTTP(S) links for activation.
pub fn validate_link(payload: Option<&Value>) -> Result<String, String> {
    let Some(Value::String(link)) = payload else {
        return Err("Only valid HTTP and HTTPS links can be opened.".into());
    };
    let lower = link.to_ascii_lowercase();
    let scheme = lower.starts_with("http://") || lower.starts_with("https://");
    if !scheme || link.chars().any(|c| c <= '\u{20}' || c == '\u{7f}') {
        return Err("Only valid HTTP and HTTPS links can be opened.".into());
    }
    let url = tc_core::node::parse_url(link).ok_or("Invalid URL")?;
    let safe = matches!(url.protocol(), "http:" | "https:")
        && !url.hostname().is_empty()
        && url.username().is_empty()
        && url.password().is_empty();
    if !safe {
        return Err("Only valid HTTP and HTTPS links without credentials can be opened.".into());
    }
    Ok(url.href().to_owned())
}

impl Host {
    pub fn new(paths: Paths, platform: Arc<dyn Platform>, backend: Box<dyn Backend>, mut config: Config) -> Arc<Host> {
        config.claude_accounts = Some(paths.claude_accounts());
        let (sender, mut messages) = tokio::sync::mpsc::unbounded_channel();
        let events = sender.clone();
        let sink: EventSink = Arc::new(move |key, event| {
            let _ = events.send(Message::Session(key, event));
        });
        let integrations: Option<Integrations> = paths.hook.clone().map(|hook| {
            let folder = paths.integration();
            Box::new(move |shell: &str, platform| tc_pty::integration::prepare(&folder, &hook, platform, shell))
                as Integrations
        });
        let (os, home, process_cwd) = (config.platform, config.home.clone(), config.process_cwd.clone());
        // Requests left while the app was closed are stale: their senders have given up.
        let inbox = paths.launch_requests();
        match tc_core::launch::create_inbox(&inbox, false) {
            Ok(()) => tc_core::launch::discard_requests(&inbox),
            Err(error) => eprintln!("Could not create {}: {error}", inbox.display()),
        }
        let mut manager = TerminalManager::new(config, backend, integrations, sink);
        let setting = KeepRunning::read(&paths.settings());
        if setting.enabled {
            manager.set_keeper(setting.keeper(&paths, manager.environment(), os).ok());
        }
        let mut state = State {
            names: Naming::default(),
            manager,
            recovery: WorkspaceRecovery::new(),
            filename: None,
            inputs: HashMap::new(),
            launches: crate::launches::Launches::new(),
            pointers: crate::pointers::Pointers::default(),
            mirror: None,
        };
        let host = Arc::new(Host {
            state: sender,
            platform,
            paths,
            os,
            home,
            process_cwd,
            writes: SerialQueue::new("tc-workspace-writes"),
            assets: SerialQueue::new("tc-assets"),
            events: Mutex::new(None),
            remote_events: tokio::sync::broadcast::channel(64).0,
            quitting: AtomicBool::new(false),
        });
        let weak = Arc::downgrade(&host);
        tauri::async_runtime::spawn(async move {
            let mut poll = tokio::time::interval(tc_pty::manager::HOOK_POLL_INTERVAL);
            poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                let message = tokio::select! {
                    message = messages.recv() => message,
                    _ = poll.tick() => Some(Message::Poll),
                };
                let Some(host) = weak.upgrade() else { break };
                match message {
                    Some(Message::Task(task)) => task(&host, &mut state),
                    Some(Message::Session(key, event)) => state.manager.handle(key, event),
                    Some(Message::Poll) => {
                        state.manager.poll_hooks();
                        state.manager.stopping();
                        state.launches.idle();
                        host.poll_launch_requests(&mut state);
                        host.poll_names(&mut state);
                    }
                    None => break,
                }
                host.dispatch(&mut state);
                if let Some(mirror) = &mut state.mirror {
                    mirror.sync(
                        state.recovery.board(),
                        state.recovery.epoch(),
                        &state.manager,
                        &host.remote_events,
                    );
                }
            }
        });
        host
    }

    fn post(&self, task: impl FnOnce(&Host, &mut State) + Send + 'static) {
        let _ = self.state.send(Message::Task(Box::new(task)));
    }

    /// One bounded local metadata read at a time, off the PTY actor. Nothing contacts a provider.
    fn poll_names(self: &Arc<Self>, state: &mut State) {
        let epoch = state.recovery.epoch();
        if state.names.epoch != epoch {
            state.names.epoch = epoch;
            state.names.entries.clear();
        }
        let now = std::time::Instant::now();
        let cards = state.recovery.board().cards.clone();
        state.names.entries.retain(|id, entry| {
            cards.iter().any(|card| {
                card.id == *id
                    && card.title_mode == Some(TitleMode::Automatic)
                    && card.title_revision == entry.revision
                    && state.manager.name_request(id).as_ref() == Some(&entry.request)
            })
        });
        for card in &cards {
            if card.title_mode != Some(TitleMode::Automatic) {
                continue;
            }
            let Some(request) = state.manager.name_request(&card.id) else {
                continue;
            };
            let entry = state.names.entries.entry(card.id.clone()).or_insert_with(|| NameEntry {
                request,
                revision: card.title_revision,
                next_read: now,
                settled: SettledTitle::default(),
                origin: now,
            });
            if let Some(title) = entry
                .settled
                .ready(&card.title, now.duration_since(entry.origin).as_secs())
                && let Ok(named) = state.recovery.rename(&card.id, TitleMode::Automatic, Some(&title))
            {
                entry.revision = named.title_revision;
                self.publish_title(state, &named);
            }
        }
        if state.names.busy {
            return;
        }
        let next = state
            .names
            .entries
            .iter_mut()
            .filter(|(_, entry)| entry.next_read <= now)
            .min_by_key(|(_, entry)| entry.next_read);
        let Some((id, entry)) = next else { return };
        let (id, request, revision) = (id.clone(), entry.request.clone(), entry.revision);
        entry.next_read = now + Duration::from_secs(5);
        state.names.busy = true;
        let weak = Arc::downgrade(self);
        tauri::async_runtime::spawn(async move {
            let reading = request.clone();
            let name = tauri::async_runtime::spawn_blocking(move || reading.read())
                .await
                .ok()
                .flatten();
            if let Some(host) = weak.upgrade() {
                host.post(move |_, state| {
                    state.names.busy = false;
                    if state.recovery.epoch() != epoch || state.manager.name_request(&id).as_ref() != Some(&request) {
                        return;
                    }
                    let Some(card) = state.recovery.board().cards.iter().find(|card| card.id == id) else {
                        return;
                    };
                    if card.title_mode != Some(TitleMode::Automatic) || card.title_revision != revision {
                        return;
                    }
                    if let (Some(name), Some(entry)) = (name, state.names.entries.get_mut(&id)) {
                        entry.settled.observe(name, entry.origin.elapsed().as_secs());
                    }
                });
            }
        });
    }

    fn publish_title(&self, state: &mut State, card: &tc_core::workspace::Card) {
        // The naming change and its recovery write are queued in the same actor turn.
        let (file, text, emitter) = (
            self.paths.recovery(),
            state.recovery.board().to_file_string(None),
            self.emitter(),
        );
        self.writes.push(move || {
            if let Err(error) = write_workspace_file(&file, &text)
                && let Some(emit) = emitter
            {
                emit(json!({ "type": "error", "message": format!("Could not save terminal title: {error}") }));
            }
        });
        let event = json!({ "type": "title", "id": card.id, "title": card.title,
            "titleMode": card.title_mode, "titleRevision": card.title_revision, "titleEpoch": state.recovery.epoch() });
        if let Some(mirror) = &mut state.mirror {
            mirror.observe(&event, &self.remote_events);
        }
        self.emit(event);
    }

    async fn with_state<R: Send + 'static>(&self, task: impl FnOnce(&Host, &mut State) -> R + Send + 'static) -> R {
        let (reply, result) = tokio::sync::oneshot::channel();
        self.post(move |host, state| {
            let value = task(host, state);
            host.dispatch(state);
            let _ = reply.send(value);
        });
        result.await.expect("the host actor is alive while Host is borrowed")
    }

    /// Where events for the UI go. `initialize` connects the renderer's channel.
    pub fn connect(&self, events: Events) {
        *self.events.lock().unwrap_or_else(|e| e.into_inner()) = Some(events);
    }

    fn emitter(&self) -> Option<Events> {
        self.events.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Sends an event to the UI, if it is connected.
    pub fn emit(&self, event: Value) {
        if let Some(events) = self.emitter() {
            events(event);
        }
    }

    fn emit_error(&self, id: Option<&str>, message: String) {
        let mut event = json!({ "type": "error", "message": message });
        if let Some(id) = id {
            event["id"] = json!(id);
        }
        self.emit(event);
    }

    /// Sends the manager's events to the UI. Directory and session metadata the host observes is
    /// saved for recovery right away.
    fn dispatch(&self, state: &mut State) {
        for event in state.pointers.reconcile(state.recovery.board(), &state.manager) {
            self.emit(event);
        }
        for event in state.manager.take_events() {
            if self.dispatch_pointer(state, &event) {
                continue;
            }
            // Requests, and the output logs of the terminals they opened.
            match &event {
                TerminalEvent::Launch {
                    request_id,
                    inbox,
                    request,
                    ..
                } => state.launches.expect(
                    request_id.clone(),
                    crate::launches::Pending {
                        inbox: inbox.clone(),
                        reply: request.reply,
                        log: request.log,
                    },
                ),
                TerminalEvent::Data { id, data } => state.launches.output(id, data),
                TerminalEvent::Exit { id, status } => state.launches.exited(id, status.code),
                _ => {}
            }
            if let TerminalEvent::Metadata { id, metadata, .. } = &event {
                let update = CardMetadata {
                    cwd: metadata.cwd.clone(),
                    session: metadata.session.clone(),
                };
                match state.recovery.update(id, update) {
                    Ok(Some(board)) => {
                        // Saved in queue order; a failure is reported, not returned.
                        let (file, text, emitter) = (self.paths.recovery(), board.to_file_string(None), self.emitter());
                        self.writes.push(move || {
                            if let Err(error) = write_workspace_file(&file, &text)
                                && let Some(emit) = emitter
                            {
                                emit(json!({ "type": "error", "message": format!("Could not save session recovery: {error}") }));
                            }
                        });
                    }
                    Ok(None) => {}
                    Err(error) => self.emit_error(None, format!("Could not save session recovery: {error}")),
                }
            }
            let event = serde_json::to_value(&event).expect("events serialize");
            if let Some(mirror) = &mut state.mirror {
                mirror.observe(&event, &self.remote_events);
            }
            self.emit(event);
        }
    }

    fn dispatch_pointer(&self, state: &mut State, event: &TerminalEvent) -> bool {
        let (source, report) = match event {
            TerminalEvent::Hook {
                id,
                generation,
                inbox,
                request_id,
                report,
            } => {
                if !state.manager.pointer_report_current(id, *generation, report)
                    || report.expires <= tc_core::pointers::now_ms()
                {
                    let _ = tc_core::pointers::answer(
                        inbox,
                        request_id,
                        &json!({"error":"Stale lifecycle hook or terminal closed."}),
                    );
                    return true;
                }
                if report.kind == "trigger" {
                    let events = state
                        .pointers
                        .fire(state.recovery.board(), id, report, &mut state.manager);
                    let failed = events.iter().filter(|event| event["state"] == "failed").count();
                    let matched = events.iter().filter(|event| event["type"] == "pointer").count();
                    for event in events {
                        self.emit(event);
                    }
                    let mut answer = json!({"matched":matched,"failed":failed});
                    if failed > 0 {
                        answer["error"] = json!("Some pointers failed; see the canvas for details.");
                    }
                    let _ = tc_core::pointers::answer(inbox, request_id, &answer);
                    return true;
                }
                let (answer, events) = state
                    .pointers
                    .continuation(state.recovery.board(), id, report, &state.manager);
                // If the CLI cannot receive the continuation, fail it rather than treating it as busy forever.
                let delivered = tc_core::pointers::answer(inbox, request_id, &answer).is_ok();
                for mut event in events {
                    if !delivered && event["state"] == "firing" {
                        event["state"] = json!("failed");
                        event["message"] = json!("Could not return the queued prompt to the target hook.");
                    }
                    self.emit(event);
                }
                if !delivered {
                    let mut failed = report.clone();
                    failed.kind = "failed".into();
                    state.manager.pointer_lifecycle(id, &failed, false);
                    return true;
                }
                state
                    .manager
                    .pointer_lifecycle(id, report, delivered && answer.get("decision").is_some());
                // Blocking Stop continues the same agent; its outgoing Stop pointers wait until
                // that continuation really finishes rather than running the next step early.
                if answer.get("decision").is_some() {
                    return true;
                }
                (id, report.clone())
            }
            TerminalEvent::CommandExit { id, code } => (
                id,
                tc_core::pointers::Report {
                    kind: "exit".into(),
                    exit_code: Some(*code),
                    token: String::new(),
                    provider: String::new(),
                    session_id: String::new(),
                    message: String::new(),
                    name: String::new(),
                    stop_hook_active: false,
                    expires: 0,
                },
            ),
            TerminalEvent::Exit { id, status } => (
                id,
                tc_core::pointers::Report {
                    kind: "exit".into(),
                    exit_code: Some(status.code),
                    token: String::new(),
                    provider: String::new(),
                    session_id: String::new(),
                    message: String::new(),
                    name: String::new(),
                    stop_hook_active: false,
                    expires: 0,
                },
            ),
            _ => return false,
        };
        for event in state
            .pointers
            .fire(state.recovery.board(), source, &report, &mut state.manager)
        {
            self.emit(event);
        }
        matches!(event, TerminalEvent::Hook { .. } | TerminalEvent::CommandExit { .. })
    }

    /// Opens terminals that programs outside the canvas asked for. Requests wait until the UI is
    /// connected, so none is taken while nothing can open it.
    fn poll_launch_requests(&self, state: &mut State) {
        if self.emitter().is_none() {
            return;
        }
        let inbox = self.paths.launch_requests();
        for taken in tc_core::launch::take_requests(&inbox, self.os) {
            let request = taken.request.and_then(|request| {
                if tc_core::dirs::is_directory(&request.cwd) {
                    Ok(request)
                } else {
                    Err(Error::Invalid("Working directory is unavailable.".into()))
                }
            });
            match (request, taken.id) {
                (Ok(request), Some(id)) => {
                    let mut event = json!({
                        "type": "launch", "external": true, "request": id, "profile": request.profile,
                        "title": request.title, "cwd": request.cwd, "command": request.command,
                    });
                    if let Some(mode) = request.title_mode {
                        event["titleMode"] = json!(mode);
                    }
                    if let Some(parent) = &request.parent {
                        event["parent"] = json!(parent);
                    }
                    state.launches.expect(
                        id,
                        crate::launches::Pending {
                            inbox: inbox.clone(),
                            reply: request.reply,
                            log: request.log,
                        },
                    );
                    self.emit(event);
                }
                (request, id) => {
                    let error = request.err().map_or_else(String::new, |error| error.to_string());
                    if let Some(id) = id {
                        crate::launches::Launches::refuse(&inbox, &id, &error);
                    }
                    self.emit_error(None, format!("Could not open the requested terminal: {error}"));
                }
            }
        }
    }

    /// Handles output, exits, and directory reports from terminal threads.
    pub fn session_event(&self, key: SessionKey, event: SessionEvent) {
        let _ = self.state.send(Message::Session(key, event));
    }

    /// Validates and queues an atomic write of `board`. The write happens in queue order; the
    /// returned future reports its result.
    fn queue_save(
        &self,
        file: PathBuf,
        board: &Workspace,
        assets: Option<&Map<String, Value>>,
    ) -> BoxFuture<Result<(), String>> {
        let text = board.to_file_string(assets);
        let done = self.writes.run(move || write_workspace_file(&file, &text));
        Box::pin(async move { done.await.unwrap_or_else(|| Err("The write queue stopped.".into())) })
    }

    /// Accepts `raw` (or the current board) for recovery and saves it.
    async fn flush(&self, raw: Option<&Value>) -> Result<(), String> {
        let raw = raw.cloned();
        // Snapshot and enqueue together: a metadata event must never enqueue a newer board
        // between these steps and then be overwritten by this older snapshot.
        let saved = self
            .with_state(move |host, state| {
                let raw = raw.as_ref().map(|raw| pointer_snapshot(state.recovery.board(), raw));
                let board = state.recovery.persist(raw.as_ref()).map_err(message)?;
                Ok::<_, String>(host.queue_save(host.paths.recovery(), &board, None))
            })
            .await?;
        saved.await
    }

    async fn read_workspace(&self, file: &Path) -> Result<Workspace, Error> {
        if std::fs::metadata(file)?.len() > limits::BYTES {
            return Err(Error::Invalid("Workspace files must be smaller than 64 MB.".into()));
        }
        let text = String::from_utf8_lossy(&std::fs::read(file)?).into_owned();
        let raw: Value = serde_json::from_str(&text).map_err(|error| Error::Invalid(error.to_string()))?;
        let assets = self.paths.assets();
        let raw = self
            .assets
            .run(move || extract_assets(raw, &assets))
            .await
            .unwrap_or_else(|| Err(Error::Invalid("The image queue stopped.".into())))?;
        validate_workspace(&raw)
    }

    async fn store(&self, bytes: Vec<u8>) -> CommandResult {
        let assets = self.paths.assets();
        let name = self
            .assets
            .run(move || store_image(&assets, &bytes))
            .await
            .ok_or("The image queue stopped.")?;
        Ok(json!({ "asset": name.map_err(message)? }))
    }

    /// Stops every terminal and waits until each has exited, for up to five seconds. Killing a
    /// terminal returns before its native cleanup finishes, so the host stays alive for it.
    async fn shutdown(&self) {
        self.with_state(|_, state| {
            state.pointers = crate::pointers::Pointers::default();
            state.manager.begin_shutdown(STOP_TIMEOUT);
        })
        .await;
        while self.with_state(|_, state| state.manager.stopping()).await > 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Runs a renderer command. Errors are the messages the UI shows.
    pub async fn command(&self, action: &str, payload: Option<&Value>) -> CommandResult {
        match action {
            "open-link" => {
                let url = validate_link(payload)?;
                self.platform.open_link(url).await?;
                Ok(json!({ "ok": true }))
            }
            "clipboard-read" => {
                let text = self.platform.read_clipboard().await?;
                if utf16_len(&text) > CLIPBOARD_UNITS {
                    return Err("Paste exceeds 1 MB.".into());
                }
                Ok(json!({ "text": text }))
            }
            "clipboard-write" => {
                let Some(Value::String(text)) =
                    payload.filter(|text| text.as_str().is_some_and(|t| utf16_len(t) <= CLIPBOARD_UNITS))
                else {
                    return Err("Selection exceeds 1 MB.".into());
                };
                self.platform.write_clipboard(text.clone()).await?;
                Ok(json!({ "ok": true }))
            }
            "initialize" => {
                let mut workspace = create_workspace();
                let mut warnings = Vec::new();
                match self.read_workspace(&self.paths.recovery()).await {
                    Ok(restored) => workspace = restored,
                    Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => warnings.push(format!("Could not restore your last workspace: {error}")),
                }
                if self.paths.hook.is_none() {
                    warnings.push(HELPER_MISSING.to_owned());
                }
                let offer_setup = self.paths.agents.as_ref().is_some_and(|agents| agents.first_launch)
                    && !self.paths.agent_setup().exists();
                // Until it is answered, each launch offers tmux if it is still missing or too old.
                let offer_tmux = match self.paths.tmux.filter(|_| !self.paths.tmux_setup().exists()) {
                    Some(probe) => tokio::task::spawn_blocking(move || {
                        let state = probe();
                        !state.usable() && state.plan.is_some()
                    })
                    .await
                    .unwrap_or(false),
                    None => false,
                };
                let restored = workspace.clone();
                let title_epoch = self
                    .with_state(move |_, state| {
                        state.recovery.reset(restored);
                        state.inputs.clear();
                        state.recovery.epoch()
                    })
                    .await;
                let mut result = json!({
                    "workspace": workspace, "profiles": PROFILES, "home": self.home, "platform": node_platform(self.os), "titleEpoch": title_epoch
                });
                // One line each, the workspace first: the UI shows them together.
                if !warnings.is_empty() {
                    result["warning"] = json!(warnings.join("\n"));
                }
                if offer_setup {
                    result["agentSetup"] = json!(true);
                }
                if offer_tmux {
                    result["tmuxSetup"] = json!(true);
                }
                result["keepRunning"] = self.keep_status().await;
                Ok(result)
            }
            // Reports whether terminals keep running after the app quits; with `enabled`, first
            // turns that on or off.
            "keep-running" => {
                let enable = match field(payload, "enabled") {
                    None => None,
                    Some(Value::Bool(enable)) => Some(*enable),
                    Some(_) => return Err("Invalid setting.".into()),
                };
                let env = self.with_state(|_, state| state.manager.environment().clone()).await;
                let (paths, os) = (self.paths.clone(), self.os);
                let (setting, keeper) = tokio::task::spawn_blocking(move || {
                    let file = paths.settings();
                    let mut setting = KeepRunning::read(&file);
                    let keeper = setting.keeper(&paths, &env, os);
                    if let Some(enable) = enable {
                        if let (true, Err(missing)) = (enable, &keeper) {
                            return Err((*missing).to_owned());
                        }
                        setting.enabled = enable;
                        setting
                            .write(&file)
                            .map_err(|error| format!("Could not save the setting: {error}"))?;
                    }
                    Ok::<_, String>((setting, keeper))
                })
                .await
                .map_err(message)??;
                if enable.is_some() {
                    let keeper = keeper.clone().ok().filter(|_| setting.enabled);
                    self.with_state(move |_, state| state.manager.set_keeper(keeper)).await;
                }
                let mut status = self.keep_status().await;
                status["enabled"] = json!(setting.enabled);
                status["available"] = json!(keeper.is_ok());
                Ok(status)
            }
            "create-card" => Ok(json!({ "card": create_card(payload.unwrap_or(&Value::Null)).map_err(message)? })),
            "rename-title" => {
                let id = field(payload, "id")
                    .and_then(Value::as_str)
                    .ok_or("Invalid terminal ID.")?
                    .to_owned();
                let mode = field(payload, "mode")
                    .and_then(Value::as_str)
                    .and_then(TitleMode::parse)
                    .ok_or("Invalid title mode.")?;
                let title = field(payload, "title").and_then(Value::as_str).map(str::to_owned);
                let epoch = field(payload, "titleEpoch").and_then(Value::as_u64);
                let (card, saved) = self
                    .with_state(move |host, state| {
                        if epoch.is_some_and(|epoch| epoch != state.recovery.epoch()) {
                            return Err("The workspace has changed.".into());
                        }
                        let card = state.recovery.rename(&id, mode, title.as_deref()).map_err(message)?;
                        state.names.entries.remove(&id);
                        let saved = host.queue_save(host.paths.recovery(), state.recovery.board(), None);
                        Ok::<_, String>((card, saved))
                    })
                    .await?;
                saved.await?;
                Ok(json!({ "card": card }))
            }
            // Lists the Claude Code accounts; with `create`, first adds that account.
            "claude-accounts" => {
                let root = self.paths.claude_accounts();
                let create = match field(payload, "create") {
                    Some(name) => Some(tc_core::accounts::validate_name(Some(name)).map_err(message)?),
                    None => None,
                };
                tokio::task::spawn_blocking(move || {
                    let created = create
                        .map(|name| tc_core::accounts::create(&root, &name))
                        .transpose()
                        .map_err(|error| format!("Could not add the Claude account: {error}"))?;
                    let accounts = tc_core::accounts::list(&root)
                        .map_err(|error| format!("Could not list Claude accounts: {error}"))?;
                    let signed_in: Map<String, Value> = accounts
                        .iter()
                        .filter_map(|name| Some((name.clone(), json!(tc_core::accounts::signed_in(&root, name)?))))
                        .collect();
                    let mut result = json!({ "accounts": accounts, "signedIn": signed_in });
                    if let Some(created) = created {
                        result["created"] = json!(created);
                    }
                    Ok(result)
                })
                .await
                .map_err(message)?
            }
            // Lists where the Terminal Canvas skill goes; with `install`, first installs it to those
            // targets; with `dismiss`, records that the first-launch offer was declined.
            "agent-setup" => {
                let agents = self
                    .paths
                    .agents
                    .clone()
                    .ok_or("Agent setup is unavailable: the home folder is unknown.")?;
                let install = match field(payload, "install") {
                    None => Vec::new(),
                    Some(Value::Array(ids)) if ids.len() <= tc_core::skills::TARGETS.len() => ids
                        .iter()
                        .map(|id| {
                            id.as_str()
                                .and_then(|id| tc_core::skills::TARGETS.into_iter().find(|known| *known == id))
                                .ok_or_else(|| "Unknown agent setup target.".to_owned())
                        })
                        .collect::<Result<_, _>>()?,
                    Some(_) => return Err("Unknown agent setup target.".into()),
                };
                let done = !install.is_empty() || field(payload, "dismiss") == Some(&json!(true));
                let (accounts, marker) = (self.paths.claude_accounts(), self.paths.agent_setup());
                tokio::task::spawn_blocking(move || {
                    let targets = || {
                        let names = tc_core::accounts::list(&accounts).unwrap_or_default();
                        let folders: Vec<PathBuf> = names
                            .iter()
                            .map(|name| tc_core::accounts::folder(&accounts, name))
                            .collect();
                        tc_core::skills::targets(&agents.home, agents.claude_config.as_deref(), &folders)
                    };
                    let mut failed = None;
                    for target in targets().iter().filter(|target| install.contains(&target.id)) {
                        if let Err(error) = tc_core::skills::install(target) {
                            failed.get_or_insert(error);
                        }
                    }
                    let save = || {
                        marker
                            .parent()
                            .map_or(Ok(()), std::fs::create_dir_all)
                            .and_then(|()| atomic::write(&marker, b"{\"offered\":true}\n", Access::Default))
                    };
                    if done && let Err(error) = save() {
                        failed.get_or_insert(format!("Could not save the agent setup: {error}"));
                    }
                    // Folders as text: a path that is not Unicode is still shown, approximately.
                    let targets: Vec<Value> = targets()
                        .into_iter()
                        .map(|target| {
                            let folders: Vec<String> = target
                                .folders
                                .iter()
                                .map(|folder| folder.display().to_string())
                                .collect();
                            json!({
                                "id": target.id, "name": target.name, "folders": folders,
                                "detected": target.detected, "status": target.status,
                            })
                        })
                        .collect();
                    match failed {
                        Some(error) => Err(error),
                        None => Ok(json!({ "targets": targets, "installed": install })),
                    }
                })
                .await
                .map_err(message)?
            }
            // Reports tmux and the command that installs it here. With `install`, the renderer runs
            // that command in a new terminal; with `install` or `dismiss`, the first-launch offer
            // is answered and not made again.
            "tmux-setup" => {
                let probe = self.paths.tmux.ok_or("The tmux setup is unavailable in this build.")?;
                let install = field(payload, "install") == Some(&json!(true));
                let dismiss = field(payload, "dismiss") == Some(&json!(true));
                let marker = self.paths.tmux_setup();
                tokio::task::spawn_blocking(move || {
                    let state = probe();
                    if install && state.plan.is_none() {
                        return Err("No supported package manager was found to install tmux.".to_owned());
                    }
                    if install || dismiss {
                        marker
                            .parent()
                            .map_or(Ok(()), std::fs::create_dir_all)
                            .and_then(|()| atomic::write(&marker, b"{\"offered\":true}\n", Access::Default))
                            .map_err(|error| format!("Could not save the tmux setup: {error}"))?;
                    }
                    Ok(state.to_json())
                })
                .await
                .map_err(message)?
            }
            "duplicate-directory" => {
                let raw = payload.cloned().unwrap_or(Value::Null);
                let request = self
                    .with_state(move |_, state| state.manager.directory(&raw))
                    .await
                    .map_err(message)?;
                let choice = match request {
                    DirectoryRequest::Ready(choice) => choice,
                    DirectoryRequest::Lookup(lookup) => {
                        let (pid, os) = (lookup.pid, lookup.platform);
                        let current = tokio::task::spawn_blocking(move || tc_pty::cwd::process_directory(pid, os))
                            .await
                            .unwrap_or(None);
                        self.with_state(move |_, state| state.manager.finish_directory(lookup, current))
                            .await
                    }
                };
                Ok(json!(choice))
            }
            "start" => {
                let payload = payload.cloned();
                let (started, id, saved) = self
                    .with_state(move |host, state| {
                        let payload = payload.as_ref();
                        if let Some(request) = field(payload, "launch")
                            .and_then(Value::as_str)
                            .filter(|id| id.starts_with("pointer-"))
                            && !state.pointers.launch_allowed(request, state.recovery.board())
                        {
                            return Err(
                                "Hook pointer was disarmed, removed, or expired before the terminal could start."
                                    .to_owned(),
                            );
                        }
                        let card = state
                            .recovery
                            .remember_card(field(payload, "card").unwrap_or(&Value::Null))
                            .map_err(message)?;
                        let raw = serde_json::to_value(&card).expect("cards serialize");
                        // A terminal a program asked for logs its output from the first byte.
                        if let Some(request) = field(payload, "launch").and_then(Value::as_str) {
                            let cols = tc_pty::manager::dimensions(
                                field(payload, "cols").unwrap_or(&Value::Null),
                                field(payload, "rows").unwrap_or(&Value::Null),
                            );
                            state
                                .launches
                                .begin_output(request, &card.id, cols.ok().map(|(cols, _)| cols));
                        }
                        let started = state.manager.start(
                            &raw,
                            field(payload, "cols"),
                            field(payload, "rows"),
                            field(payload, "mode"),
                        );
                        host.dispatch(state);
                        if started.is_err() {
                            state.launches.forget_output(&card.id);
                        }
                        let started = started.map_err(message)?;
                        let board = state.recovery.persist(None).map_err(message)?;
                        Ok::<_, String>((started, card.id, host.queue_save(host.paths.recovery(), &board, None)))
                    })
                    .await?;
                if let Err(error) = saved.await {
                    self.with_state(move |_, state| state.manager.stop_within(&id, STOP_TIMEOUT))
                        .await;
                    return Err(error);
                }
                Ok(json!(started))
            }
            "launch-result" => {
                let result = crate::launches::parse_result(payload)?;
                let answered = self
                    .with_state(move |host, state| {
                        if let Some(event) = state.pointers.launch_finished(&result.request, result.error.as_deref()) {
                            host.emit(event);
                            return true;
                        }
                        let warning = result
                            .card
                            .as_deref()
                            .filter(|card| state.manager.integrated(card) == Some(false))
                            .map(|_| NO_INTEGRATION);
                        state.launches.answer(
                            &result.request,
                            result.card.as_deref(),
                            result.parent.as_deref(),
                            result.error.as_deref(),
                            warning,
                        )
                    })
                    .await;
                Ok(json!({ "ok": answered }))
            }
            "stop" => {
                if let Some(id) = field(payload, "id").and_then(Value::as_str) {
                    let id = id.to_owned();
                    let remove = field(payload, "removePointers").and_then(Value::as_bool) == Some(true);
                    let saved = self
                        .with_state(move |host, state| {
                            state.manager.stop(&id);
                            if !remove {
                                return Ok(None);
                            }
                            let mut raw = state.recovery.board().to_value();
                            raw["items"].as_array_mut().expect("validated items").retain(|item| {
                                item.get("hook").is_none() || (item["start"]["id"] != id && item["end"]["id"] != id)
                            });
                            let item_ids: std::collections::HashSet<String> = raw["items"]
                                .as_array()
                                .expect("validated items")
                                .iter()
                                .filter_map(|item| item["id"].as_str().map(str::to_owned))
                                .collect();
                            if let Some(canvases) = raw.get_mut("canvases").and_then(Value::as_array_mut) {
                                for canvas in canvases {
                                    canvas["itemIds"]
                                        .as_array_mut()
                                        .expect("validated canvas")
                                        .retain(|item| item.as_str().is_some_and(|id| item_ids.contains(id)));
                                }
                            }
                            let board = state.recovery.accept(&raw).map_err(message)?.clone();
                            host.dispatch(state);
                            Ok::<_, String>(Some(host.queue_save(host.paths.recovery(), &board, None)))
                        })
                        .await?;
                    if let Some(saved) = saved {
                        saved.await?;
                    }
                }
                Ok(json!({ "ok": true }))
            }
            "pick-folder" => {
                let field_cwd = field(payload, "cwd").and_then(Value::as_str);
                let default = tc_core::dirs::fallback_directory([field_cwd, Some(&self.home), Some(&self.process_cwd)]);
                let default = (!default.is_empty()).then(|| PathBuf::from(default));
                let path = self.platform.pick_folder(default).await;
                Ok(json!({ "path": path.map(|path| path.to_string_lossy().into_owned()) }))
            }
            "pointer-configure" => {
                let payload = payload.cloned().ok_or("Invalid hook pointer configuration.")?;
                let saved = self
                    .with_state(move |host, state| {
                        let snapshot = pointer_snapshot(state.recovery.board(), &payload["workspace"]);
                        let mut raw = state.recovery.merge(&snapshot).map_err(message)?.to_value();
                        if let Some(paused) = payload.get("paused") {
                            if !paused.is_boolean() {
                                return Err("Invalid global hook pause.".to_owned());
                            }
                            raw["hooksPaused"] = paused.clone();
                        } else {
                            let id = payload["id"].as_str().ok_or("Invalid hook pointer ID.")?;
                            let item = raw["items"]
                                .as_array_mut()
                                .and_then(|items| items.iter_mut().find(|item| item["id"] == id))
                                .ok_or("The hook pointer arrow was removed.")?;
                            if payload["hook"].is_null() {
                                item.as_object_mut().expect("validated item").remove("hook");
                            } else {
                                item["hook"] = payload["hook"].clone();
                            }
                        }
                        let board = state.recovery.accept(&raw).map_err(message)?.clone();
                        host.dispatch(state);
                        Ok::<_, String>(host.queue_save(host.paths.recovery(), &board, None))
                    })
                    .await?;
                if let Err(error) = saved.await {
                    self.with_state(|host, state| {
                        let mut raw = state.recovery.board().to_value();
                        raw["hooksPaused"] = json!(true);
                        let _ = state.recovery.accept(&raw);
                        host.dispatch(state);
                        host.emit(json!({"type":"pointers-paused", "message":"Could not save hook configuration. All hooks have been paused."}));
                    }).await;
                    return Err(error);
                }
                Ok(json!({"ok":true}))
            }
            "autosave" => {
                self.flush(payload).await?;
                Ok(json!({ "ok": true }))
            }
            "save" | "save-as" => {
                let raw = payload.cloned().unwrap_or(Value::Null);
                let use_filename = action == "save";
                let (board, target) = self
                    .with_state(move |host, state| {
                        state.manager.snapshot();
                        host.dispatch(state);
                        let raw = pointer_snapshot(state.recovery.board(), &raw);
                        let board = state.recovery.accept(&raw).map_err(message)?.clone();
                        let target = if use_filename { state.filename.clone() } else { None };
                        Ok::<_, String>((board, target))
                    })
                    .await?;
                let target = match target {
                    Some(target) => target,
                    None => {
                        let name = format!("{}.terminalcanvas", file_stem(&board.name));
                        match self.platform.save_file("Save workspace", name).await {
                            Some(target) => target,
                            None => return Ok(json!({ "canceled": true })),
                        }
                    }
                };
                let file = target.clone();
                let saved = self
                    .with_state(move |host, state| {
                        state.manager.snapshot();
                        host.dispatch(state);
                        let merged = state
                            .recovery
                            .merge(&pointer_snapshot(state.recovery.board(), &board.to_value()))
                            .map_err(message)?;
                        Ok::<_, String>(host.queue_save(file, &merged, None))
                    })
                    .await?;
                saved.await?;
                self.with_state(move |_, state| state.filename = Some(target)).await;
                Ok(json!({ "ok": true }))
            }
            "export" => {
                let raw = payload.cloned().unwrap_or(Value::Null);
                let board = self
                    .with_state(move |host, state| {
                        state.manager.snapshot();
                        host.dispatch(state);
                        state
                            .recovery
                            .accept(&pointer_snapshot(state.recovery.board(), &raw))
                            .cloned()
                            .map_err(message)
                    })
                    .await?;
                let name = format!("{} (portable).terminalcanvas", file_stem(&board.name));
                let Some(target) = self.platform.save_file("Export portable workspace", name).await else {
                    return Ok(json!({ "canceled": true }));
                };
                let assets = self.paths.assets();
                let exporting = board.clone();
                let embedded = self
                    .assets
                    .run(move || embed_assets(&exporting, &assets))
                    .await
                    .ok_or("The image queue stopped.")?;
                let (images, missing) = (embedded.assets.len(), embedded.missing.len());
                let saved = self
                    .with_state(move |host, state| {
                        state.manager.snapshot();
                        host.dispatch(state);
                        let merged = state
                            .recovery
                            .merge(&pointer_snapshot(state.recovery.board(), &board.to_value()))
                            .map_err(message)?;
                        Ok::<_, String>(host.queue_save(target, &merged, Some(&embedded.assets)))
                    })
                    .await?;
                saved.await?;
                Ok(json!({ "ok": true, "images": images, "missing": missing }))
            }
            "pick-image" => {
                let Some(file) = self.platform.open_file("Add an image", FileKind::Image).await else {
                    return Ok(json!({ "canceled": true }));
                };
                if std::fs::metadata(&file).map_err(message)?.len() > IMAGE_BYTES as u64 {
                    return Err("Images must be smaller than 15 MB.".into());
                }
                self.store(std::fs::read(&file).map_err(message)?).await
            }
            // Cleanup is manual: the renderer confirms the count first, and the list is computed
            // again on delete.
            "unused-images" | "delete-unused-images" => {
                let keep = keep_list(field(payload, "keep").unwrap_or(&Value::Null)).map_err(message)?;
                let assets = self.paths.assets();
                if action == "delete-unused-images" {
                    let deleted = self
                        .assets
                        .run(move || unused_assets(&assets, &keep).map(|unused| delete_assets(&assets, &unused)))
                        .await
                        .ok_or("The image queue stopped.")?;
                    return Ok(json!(deleted.map_err(message)?));
                }
                let unused = self
                    .assets
                    .run(move || unused_assets(&assets, &keep))
                    .await
                    .ok_or("The image queue stopped.")?;
                let unused = unused.map_err(message)?;
                Ok(json!({ "count": unused.len(), "bytes": unused.iter().map(|asset| asset.bytes).sum::<u64>() }))
            }
            "open" => {
                let Some(file) = self.platform.open_file("Open workspace", FileKind::Workspace).await else {
                    return Ok(json!({ "canceled": true }));
                };
                let workspace = self.read_workspace(&file).await.map_err(message)?;
                let opened = workspace.clone();
                let title_epoch = self
                    .with_state(move |host, state| {
                        state.manager.stop_all();
                        host.dispatch(state);
                        state.manager.forget();
                        state.pointers = crate::pointers::Pointers::default();
                        state.recovery.reset(opened);
                        state.recovery.epoch()
                    })
                    .await;
                self.flush(None).await?;
                self.with_state(move |_, state| state.filename = Some(file)).await;
                let keep = self.keep_status().await;
                Ok(json!({ "workspace": workspace, "titleEpoch": title_epoch, "keepRunning": keep }))
            }
            "new" => {
                self.with_state(|host, state| {
                    state.manager.stop_all();
                    host.dispatch(state);
                    state.manager.forget();
                    state.pointers = crate::pointers::Pointers::default();
                    state.filename = None;
                    state.recovery.reset(create_workspace());
                })
                .await;
                self.flush(None).await?;
                Ok(self
                    .with_state(
                        |_, state| json!({ "workspace": state.recovery.board(), "titleEpoch": state.recovery.epoch() }),
                    )
                    .await)
            }
            "close" => {
                self.with_state(|_, state| {
                    state.manager.snapshot();
                })
                .await;
                self.flush(payload).await?;
                self.shutdown().await;
                self.flush(None).await?;
                self.quitting.store(true, Ordering::SeqCst);
                self.platform.close_window();
                Ok(json!({ "ok": true }))
            }
            _ => Err("Unsupported desktop command.".into()),
        }
    }

    /// Whether terminals keep running after the app quits, how (`helper` or `tmux`), and the cards
    /// whose terminals are still running, which the renderer attaches to.
    async fn keep_status(&self) -> Value {
        let keeper = self.with_state(|_, state| state.manager.keeper().cloned()).await;
        let via = match &keeper {
            Some(Keeper::Daemon(_)) => Some("helper"),
            Some(Keeper::Tmux(_)) => Some("tmux"),
            None => None,
        };
        let sessions = match keeper {
            Some(keeper) => tokio::task::spawn_blocking(move || keeper.sessions())
                .await
                .unwrap_or_default(),
            None => Vec::new(),
        };
        json!({ "enabled": via.is_some(), "via": via, "sessions": sessions })
    }

    /// `import-image`: the image arrives as the raw IPC body.
    pub async fn import_image(&self, bytes: Option<Vec<u8>>) -> CommandResult {
        self.store(bytes.ok_or("Invalid image data.")?).await
    }

    /// Typed input. The bridge numbers each terminal's input; pieces are written in that order.
    pub fn input(&self, id: &str, data: String, sequence: u64) {
        let id = id.to_owned();
        self.post(move |host, state| {
            let order = state.inputs.entry(id.clone()).or_default();
            if sequence < order.next {
                return;
            }
            // xterm sends focus reports when a canvas is hidden or revealed. They do not
            // edit the shell's input buffer, but must still reach programs requesting them.
            if !matches!(data.as_str(), "\x1b[I" | "\x1b[O") {
                state.manager.pointer_typed(&id);
            }
            order.waiting.entry(sequence).or_insert(data);
            let mut ready = Vec::new();
            while let Some(data) = order.waiting.remove(&order.next) {
                order.next += 1;
                ready.push(data);
            }
            for data in ready {
                if let Err(error) = state.manager.write(&id, &data) {
                    host.emit_error(Some(&id), error.to_string());
                }
            }
        });
    }

    pub fn resize(&self, id: &str, cols: &Value, rows: &Value) {
        let (id, cols, rows) = (id.to_owned(), cols.clone(), rows.clone());
        self.post(move |host, state| {
            if let Err(error) = state.manager.resize(&id, &cols, &rows) {
                host.emit_error(Some(&id), error.to_string());
            } else if let Ok((cols, _)) = tc_pty::manager::dimensions(&cols, &rows) {
                state.launches.resize(&id, cols);
            }
        });
    }

    pub fn acknowledge(&self, id: &str, amount: &Value) {
        let (id, amount) = (id.to_owned(), amount.clone());
        self.post(move |_, state| state.manager.acknowledge(&id, &amount));
    }

    fn closing(&self) {
        self.post(|host, state| host.emit(json!({ "type": "closing", "running": state.manager.running() })));
    }

    pub fn quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }

    /// The window's close button. Returns whether to keep the window open: the renderer is asked
    /// to confirm, then sends `close`.
    pub fn close_requested(&self) -> bool {
        if !self.quitting() {
            self.closing();
            return true;
        }
        self.stop_all();
        false
    }

    /// Quitting the app (Cmd+Q, or the last window closing). Returns whether to keep running.
    pub fn exit_requested(&self) -> bool {
        if self.quitting() {
            return false;
        }
        self.closing();
        true
    }

    pub fn stop_all(&self) {
        self.post(|_, state| state.manager.stop_all());
    }

    /// The webview's renderer process died: keep the last host-known workspace and close.
    pub async fn renderer_crashed(&self) {
        self.shutdown().await;
        if let Err(error) = self.flush(None).await {
            eprintln!("Could not save the workspace after the renderer stopped: {error}");
        }
        self.quitting.store(true, Ordering::SeqCst);
        self.platform.close_window();
    }

    /// The folder `tc-asset` serves images from.
    pub fn assets_folder(&self) -> PathBuf {
        self.paths.assets()
    }

    /// Attaches to live state without desktop initialization, recovery reset, or input reset.
    pub async fn remote_attach(&self) -> (Value, tokio::sync::broadcast::Receiver<Value>) {
        self.with_state(|host, state| {
            let mirror = state.mirror.get_or_insert_with(crate::remote_mirror::Mirror::new);
            let events = host.remote_events.subscribe();
            let mut snapshot = mirror.snapshot(state.recovery.board(), &state.manager);
            snapshot["profiles"] = json!(PROFILES);
            snapshot["home"] = json!(host.home);
            snapshot["platform"] = json!(node_platform(host.os));
            snapshot["titleEpoch"] = json!(state.recovery.epoch());
            (snapshot, events)
        })
        .await
    }

    pub async fn remote_detach(&self) {
        self.with_state(|_, state| state.mirror = None).await;
    }

    /// WebSocket order is already serial. It must not share the desktop bridge's sequence map.
    /// Recheck revocation inside the actor so queued input cannot outlive its authorization.
    pub async fn remote_input(&self, id: String, data: String, active: Arc<AtomicBool>) -> CommandResult {
        self.with_state(move |_, state| {
            if !active.load(Ordering::Acquire) {
                return Err("Session revoked.".into());
            }
            state.manager.pointer_typed(&id);
            state.manager.write(&id, &data).map_err(message)?;
            Ok(json!({ "ok": true }))
        })
        .await
    }

    /// For tests: the number of running terminals.
    pub async fn running(&self) -> usize {
        self.with_state(|_, state| state.manager.running()).await
    }

    #[cfg(feature = "e2e")]
    pub async fn diagnostics(&self) -> Value {
        self.with_state(|host, state| {
            state.manager.snapshot();
            host.dispatch(state);
            json!({
                "running": state.manager.running(),
                "home": host.home,
                "stopping": state.manager.stopping(),
                "workspace": state.recovery.board(),
                "terminals": state.recovery.board().cards.iter().map(|card| json!({
                    "id": card.id,
                    "running": state.manager.is_running(&card.id),
                    "pid": state.manager.process_id(&card.id),
                    "pending": state.manager.pending_output(&card.id),
                    "cwd": state.manager.live_directory(&card.id),
                })).collect::<Vec<_>>()
            })
        })
        .await
    }
}

/// Node's `process.platform`.
pub fn node_platform(os: Os) -> &'static str {
    match os {
        Os::Windows => "win32",
        Os::MacOs => "darwin",
        Os::Linux => "linux",
        Os::Other => "unknown",
    }
}

/// Creates the folder if needed and replaces the file atomically.
fn write_workspace_file(file: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(message)?;
    }
    atomic::write(file, text.as_bytes(), Access::Default).map_err(message)
}
