//! Terminals that keep running through tmux (macOS and Linux; Windows uses [`crate::daemon`]).
//!
//! Each card's shell runs in its own tmux session, `tc-<card ID>`, on a dedicated server socket
//! ([`SOCKET`]). The card's PTY only runs a tmux client attached to that session. Quitting the app
//! ends the client and leaves the session running; starting the card again attaches to it. Stop
//! ends the session.
//!
//! The session is created by a separate `tmux new-session -d` in its own process group, so the tmux
//! server survives the app.
//!
//! tmux does not forward the integration's escape sequences (OSC 7, 633) to its clients. tmux keeps
//! the last OSC 7 directory as `pane_path`, and in tmux the integration also records each AI launch
//! and end in the pane options [`LAUNCH_OPTION`] and [`END_OPTION`]. One [`Watch`] thread lists
//! every pane once a second and turns changes back into the same escape sequences, which the
//! manager reads without showing them.

use std::collections::{BTreeMap, HashMap};
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use serde_json::Value;

use crate::integration::Integration;
use crate::manager::{EventSink, SessionEvent, SessionKey};

/// The tmux server socket name (`tmux -L terminal-canvas`), kept apart from the user's own server.
pub const SOCKET: &str = "terminal-canvas";
/// Names the tmux executable inside a pane, so the integration can record AI launches.
pub const PROGRAM_ENV: &str = "TC_TMUX";
/// The pane option holding the last AI launch report: `<sequence>;<base64 JSON>`.
pub const LAUNCH_OPTION: &str = "@tc_launch";
/// The pane option holding the last AI end report.
pub const END_OPTION: &str = "@tc_end";
/// The session option holding the integration files of the session, for a later attach.
const INTEGRATION_OPTION: &str = "@tc_integration";
/// How often the watch lists the panes.
pub const WATCH_INTERVAL: Duration = Duration::from_secs(1);
const SESSION_PREFIX: &str = "tc-";

/// Where Homebrew and distributions install tmux; apps started from the macOS Dock get a short `PATH`.
const FALLBACKS: &[&str] = &["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"];

/// The tmux session name of a card.
pub fn session_name(card: &str) -> String {
    format!("{SESSION_PREFIX}{card}")
}

/// The card of a tmux session name made by [`session_name`].
pub fn card_of(session: &str) -> Option<&str> {
    session.strip_prefix(SESSION_PREFIX).filter(|card| !card.is_empty())
}

/// Finds tmux: `explicit` when given and present, else `PATH`, else the usual install folders.
pub fn find(explicit: Option<&Path>, env: &BTreeMap<String, String>) -> Option<PathBuf> {
    if let Some(explicit) = explicit {
        return explicit.is_file().then(|| explicit.to_owned());
    }
    env.get("PATH")
        .map(String::as_str)
        .unwrap_or_default()
        .split(':')
        .filter(|folder| !folder.is_empty())
        .map(|folder| Path::new(folder).join("tmux"))
        .chain(FALLBACKS.iter().map(PathBuf::from))
        .find(|candidate| candidate.is_file())
}

/// A tmux executable and the environment its commands run with.
#[derive(Debug, Clone)]
pub struct Tmux {
    pub program: PathBuf,
    /// The environment the tmux server starts with, and so every pane's base environment.
    env: BTreeMap<String, String>,
}

/// What [`Tmux::new_session`] starts in the session.
#[derive(Debug, Clone)]
pub struct NewSession<'a> {
    pub card: &'a str,
    pub cwd: &'a str,
    pub cols: u16,
    pub rows: u16,
    pub shell: &'a str,
    pub args: &'a [String],
    /// Variables the pane gets on top of the server's environment.
    pub env: &'a [(String, String)],
    pub integration: Option<&'a Integration>,
}

/// One pane, from [`Tmux::panes`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pane {
    pub session: String,
    pub path: String,
    pub launch: String,
    pub end: String,
    /// The directory of the pane's process, as tmux sees it.
    pub current: String,
}

impl Tmux {
    /// `env` is the environment shells inherit; it becomes the server's environment.
    pub fn new(program: PathBuf, env: BTreeMap<String, String>) -> Self {
        Tmux { program, env }
    }

    /// A tmux command on the Terminal Canvas socket.
    fn command(&self) -> Command {
        let mut command = Command::new(&self.program);
        command
            .env_clear()
            .envs(&self.env)
            .args(["-u", "-L", SOCKET])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    fn run(&self, args: &[&str]) -> io::Result<Output> {
        let mut command = self.command();
        command.args(args);
        spawn_detached(&mut command)
    }

    /// Whether the card's session is running.
    pub fn has_session(&self, card: &str) -> bool {
        let target = format!("={}", session_name(card));
        self.run(&["has-session", "-t", &target])
            .is_ok_and(|output| output.status.success())
    }

    /// The cards whose sessions are running.
    pub fn sessions(&self) -> Vec<String> {
        let Ok(output) = self.run(&["list-sessions", "-F", "#{session_name}"]) else {
            return Vec::new();
        };
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(card_of)
            .map(str::to_owned)
            .collect()
    }

    /// Every pane on the socket.
    pub fn panes(&self) -> Vec<Pane> {
        let format = format!(
            "#{{session_name}}\t#{{pane_path}}\t#{{{LAUNCH_OPTION}}}\t#{{{END_OPTION}}}\t#{{pane_current_path}}"
        );
        let Ok(output) = self.run(&["list-panes", "-a", "-F", &format]) else {
            return Vec::new();
        };
        let mut panes = parse_panes(&String::from_utf8_lossy(&output.stdout));
        // Shells without the integration report no directory; tmux knows the pane's own directory.
        for pane in &mut panes {
            if pane.path.is_empty() && pane.current.starts_with('/') {
                pane.path = file_url(&pane.current);
            }
        }
        panes
    }

    /// Starts the card's session, detached and in its own process group, so it outlives the app.
    pub fn new_session(&self, session: &NewSession) -> io::Result<()> {
        let name = session_name(session.card);
        let mut command = self.command();
        let (cols, rows) = (session.cols.to_string(), session.rows.to_string());
        command.args([
            "new-session",
            "-d",
            "-s",
            &name,
            "-x",
            &cols,
            "-y",
            &rows,
            "-c",
            session.cwd,
        ]);
        let program = (PROGRAM_ENV.to_owned(), self.program.to_string_lossy().into_owned());
        for (key, value) in session.env.iter().chain([&program]) {
            command.arg("-e").arg(format!("{key}={value}"));
        }
        command.arg("--").arg(session.shell).args(session.args);
        // This command may start the server, which inherits its output handles: through a pipe,
        // reading the output would wait for the server. Errors go to a file instead.
        let errors = std::env::temp_dir().join(format!("tc-tmux-{}.log", uuid::Uuid::new_v4()));
        command.stdout(Stdio::null()).stderr(std::fs::File::create(&errors)?);
        let mut output = spawn_detached(&mut command);
        if let Ok(output) = &mut output {
            output.stderr = std::fs::read(&errors).unwrap_or_default();
        }
        let _ = std::fs::remove_file(&errors);
        let output = output?;
        if !output.status.success() {
            return Err(failure("start a tmux session", &output));
        }
        if let Some(integration) = session.integration {
            let saved = base64::engine::general_purpose::STANDARD.encode(integration.saved().to_string());
            let target = format!("={name}:");
            let output = self.run(&["set-option", "-t", &target, INTEGRATION_OPTION, &saved])?;
            if !output.status.success() {
                self.kill_session(session.card);
                return Err(failure("record the tmux session", &output));
            }
        }
        Ok(())
    }

    /// The integration files recorded when the card's session started.
    pub fn integration(&self, card: &str) -> Option<Integration> {
        let target = format!("={}:", session_name(card));
        let output = self
            .run(&["show-options", "-v", "-t", &target, INTEGRATION_OPTION])
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let bytes = base64::engine::general_purpose::STANDARD.decode(text.trim()).ok()?;
        Integration::restore(&serde_json::from_slice::<Value>(&bytes).ok()?)
    }

    /// Ends the card's session and everything running in it.
    pub fn kill_session(&self, card: &str) {
        let target = format!("={}", session_name(card));
        let _ = self.run(&["kill-session", "-t", &target]);
    }

    /// The program and arguments of a client attached to the card's session.
    pub fn attach(&self, card: &str) -> (String, Vec<String>) {
        let args = ["-u", "-L", SOCKET, "attach-session", "-t"]
            .into_iter()
            .map(str::to_owned)
            .chain([format!("={}", session_name(card))])
            .collect();
        (self.program.to_string_lossy().into_owned(), args)
    }
}

fn failure(action: &str, output: &Output) -> io::Error {
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    let detail = if detail.is_empty() {
        format!("tmux exited with {}", output.status)
    } else {
        detail
    };
    io::Error::other(format!("Could not {action}: {detail}"))
}

/// Parses `list-panes` output: session, path, launch, and end, separated by tabs.
pub fn parse_panes(text: &str) -> Vec<Pane> {
    text.lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            let session = fields.next()?.to_owned();
            card_of(&session)?;
            let mut next = || fields.next().unwrap_or_default().to_owned();
            Some(Pane {
                session,
                path: next(),
                launch: next(),
                end: next(),
                current: next(),
            })
        })
        .collect()
}

/// A `file://` URL of an absolute POSIX path, as the Bash integration writes it for OSC 7.
fn file_url(path: &str) -> String {
    let mut url = String::from("file://localhost");
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || b"/-._~".contains(&byte) {
            url.push(char::from(byte));
        } else {
            url.push_str(&format!("%{byte:02X}"));
        }
    }
    url
}

/// The JSON of an option value `<sequence>;<base64>`, as an OSC 633 report.
fn report(value: &str) -> Option<String> {
    let (_, encoded) = value.split_once(';')?;
    let encoded = encoded.trim();
    if encoded.is_empty()
        || !encoded
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b))
    {
        return None;
    }
    Some(format!("\x1b]633;TC;{encoded}\x07"))
}

/// Lists every pane once a second while any session is attached, reporting what changed to the
/// attached card as [`SessionEvent::Report`]s. Dropping it ends the thread.
pub struct Watch {
    sessions: Arc<Mutex<HashMap<String, Watched>>>,
    stop: Arc<AtomicBool>,
}

struct Watched {
    key: SessionKey,
    last: Option<Pane>,
}

impl Watch {
    pub fn new(tmux: Tmux, events: EventSink) -> Self {
        let sessions: Arc<Mutex<HashMap<String, Watched>>> = Arc::default();
        let stop = Arc::new(AtomicBool::new(false));
        let (watched, stopped) = (Arc::clone(&sessions), Arc::clone(&stop));
        let _ = std::thread::Builder::new()
            .name("tc-tmux-watch".to_owned())
            .spawn(move || {
                while !stopped.load(Ordering::SeqCst) {
                    std::thread::sleep(WATCH_INTERVAL);
                    if watched.lock().is_ok_and(|sessions| sessions.is_empty()) {
                        continue;
                    }
                    let panes = tmux.panes();
                    let mut reports = Vec::new();
                    if let Ok(mut sessions) = watched.lock() {
                        for pane in panes {
                            let Some(entry) = sessions.get_mut(&pane.session) else {
                                continue;
                            };
                            for text in changes(entry.last.as_ref(), &pane) {
                                reports.push((entry.key.clone(), text));
                            }
                            entry.last = Some(pane);
                        }
                    }
                    for (key, text) in reports {
                        events(key, SessionEvent::Report(text));
                    }
                }
            });
        Watch { sessions, stop }
    }

    pub fn add(&self, key: SessionKey) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.insert(session_name(&key.id), Watched { key, last: None });
        }
    }

    pub fn remove(&self, card: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(&session_name(card));
        }
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// The escape sequences that report what changed since `last`: the directory, then a launch, then
/// an end, so a short launch that started and ended between two listings is still matched.
fn changes(last: Option<&Pane>, pane: &Pane) -> Vec<String> {
    let mut reports = Vec::new();
    if !pane.path.is_empty() && last.is_none_or(|last| last.path != pane.path) {
        reports.push(format!("\x1b]7;{}\x07", pane.path));
    }
    if last.is_none_or(|last| last.launch != pane.launch) {
        reports.extend(report(&pane.launch));
    }
    if last.is_none_or(|last| last.end != pane.end) {
        reports.extend(report(&pane.end));
    }
    reports
}

/// Runs a tmux command in its own process group, so the server it may start has no controlling
/// terminal and is not hung up with the app's.
fn spawn_detached(command: &mut Command) -> io::Result<Output> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command.output()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pane(path: &str, launch: &str, end: &str) -> Pane {
        Pane {
            session: "tc-a".into(),
            path: path.into(),
            launch: launch.into(),
            end: end.into(),
            current: String::new(),
        }
    }

    #[test]
    fn session_names_round_trip() {
        let name = session_name("0f0e-1");
        assert_eq!(name, "tc-0f0e-1");
        assert_eq!(card_of(&name), Some("0f0e-1"));
        assert_eq!(card_of("tc-"), None);
        assert_eq!(card_of("main"), None);
    }

    #[test]
    fn panes_parse_and_skip_other_sessions() {
        let panes = parse_panes("tc-a\tfile:///D:/x\t1;YWJj\t\nmain\t/home\t\t\ntc-b\t\t\t2;ZGVm\n");
        assert_eq!(panes.len(), 2);
        assert_eq!(panes[0], pane("file:///D:/x", "1;YWJj", ""));
        assert_eq!(panes[1].session, "tc-b");
        assert_eq!(panes[1].end, "2;ZGVm");
    }

    #[test]
    fn changes_report_directory_then_launch_then_end() {
        let first = pane("file:///D:/x", "1;YWJj", "2;ZGVm");
        assert_eq!(
            changes(None, &first),
            vec![
                "\x1b]7;file:///D:/x\x07".to_owned(),
                "\x1b]633;TC;YWJj\x07".to_owned(),
                "\x1b]633;TC;ZGVm\x07".to_owned()
            ]
        );
        assert!(changes(Some(&first), &first).is_empty());
        let moved = pane("file:///D:/y", "1;YWJj", "2;ZGVm");
        assert_eq!(
            changes(Some(&first), &moved),
            vec!["\x1b]7;file:///D:/y\x07".to_owned()]
        );
        // Values that are not `<sequence>;<base64>` are ignored.
        assert!(changes(None, &pane("", "garbage", "3;not base64!")).is_empty());
    }

    #[test]
    fn file_urls_escape_like_the_bash_integration() {
        assert_eq!(file_url("/home/a b/c#d"), "file://localhost/home/a%20b/c%23d");
    }

    // tmux is looked up on macOS and Linux only, where `PATH` entries are separated by `:`.
    #[cfg(unix)]
    #[test]
    fn find_prefers_an_explicit_program_then_path() {
        let folder = std::env::temp_dir().join(format!("tc-tmux-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&folder).unwrap();
        let program = folder.join("tmux");
        std::fs::write(&program, b"").unwrap();
        let env = BTreeMap::from([("PATH".to_owned(), folder.to_string_lossy().into_owned())]);
        assert_eq!(find(None, &env), Some(program.clone()));
        assert_eq!(find(Some(&program), &BTreeMap::new()), Some(program.clone()));
        assert_eq!(find(Some(&folder.join("missing")), &env), None);
        std::fs::remove_dir_all(folder).unwrap();
    }
}
