//! Terminals that keep running after the app quits, through the app's own helper (Windows).
//!
//! `tc-hook terminal-daemon <state file>` ([`serve`]) runs outside the app's process job and owns
//! each kept terminal's pseudoconsole, through the same [`PtyBackend`] the app uses for its other
//! terminals. The app reaches it on loopback TCP: one connection per attached terminal, and short
//! ones to list and end terminals. The helper passes output through unchanged, so a kept terminal
//! types and redraws as fast as any other, and the integration's escape sequences arrive as usual.
//! (tmux on Windows, through MSYS2, added a second pseudoconsole and Cygwin's emulation, which made
//! every keystroke about three times slower and redrew the screen through tmux.)
//!
//! Messages are lines of JSON. Before anything else, each side proves it knows the secret in the
//! state file, which the helper writes with owner-only access in the app's data folder: a client
//! never sends a terminal's environment to a program that merely took the helper's old port.
//!
//! The helper keeps each terminal's recent output. Attaching again replays it (as scrollback),
//! restores the terminal modes it set, and resizes the pseudoconsole, which makes ConPTY repaint the
//! whole screen, so the view is exact whatever the replay left. A terminal that ends while no app
//! is attached has its integration files removed by the helper. With no terminals and no
//! connections for [`IDLE_EXIT`], the helper exits.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tc_core::atomic::{self, Access};
use tc_core::js::utf16_len;

use crate::integration::Integration;
use crate::manager::{Backend, EventSink, ExitStatus, Process, SessionEvent, SessionKey, SpawnRequest};
use crate::pty::PtyBackend;

/// `tc-hook terminal-daemon <state file>` runs [`serve`].
pub const COMMAND: &str = "terminal-daemon";
/// Changes whenever a message changes meaning; each side refuses another protocol.
pub const PROTOCOL: u32 = 1;
/// A helper with no terminals and no connections exits after this long.
pub const IDLE_EXIT: Duration = Duration::from_secs(30);
/// Output kept for each terminal to replay when it is attached again, in UTF-8 bytes. The
/// renderer keeps 5000 lines of scrollback.
const HISTORY_LIMIT: usize = 1024 * 1024;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
/// Older helpers kept the handshake's read timeout on an attached connection.
const LEGACY_KEEPALIVE: Duration = Duration::from_secs(2);
/// The longest handshake line, before the other side has proved itself.
const HANDSHAKE_LIMIT: u64 = 4096;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const START_TIMEOUT: Duration = Duration::from_secs(10);
const CARD_LIMIT: usize = 256;
/// The most output one write to a connection gathers from queued messages.
const WRITE_BATCH: usize = 256 * 1024;
/// Terminal modes a replay restores after the kept output: cursor keys, cursor visibility, the
/// alternate screen, mouse reporting, focus reporting, and bracketed paste.
const TRACKED_MODES: &[u16] = &[1, 25, 47, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 1047, 1049, 2004];

const MISMATCH: &str = "Terminals kept running by another version of Terminal Canvas are still open. Stop them in that version, or end the tc-hook helper process, then try again.";

/// Where a running helper listens, written by the helper itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct State {
    protocol: u32,
    port: u16,
    pid: u32,
    secret: String,
}

fn read_state(file: &Path) -> Option<State> {
    serde_json::from_slice(&fs::read(file).ok()?).ok()
}

fn random() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Proves knowledge of `secret` for `nonce`, which the other side chose, so it cannot be replayed.
fn proof(secret: &str, role: &str, nonce: &str) -> String {
    hex(&Sha256::digest(format!("terminal-canvas\n{role}\n{nonce}\n{secret}")))
}

fn same(a: &str, b: &str) -> bool {
    a.as_bytes().ct_eq(b.as_bytes()).into()
}

fn line(message: &Value) -> String {
    let mut line = message.to_string();
    line.push('\n');
    line
}

fn send(stream: &mut impl Write, message: &Value) -> io::Result<()> {
    stream.write_all(line(message).as_bytes())?;
    stream.flush()
}

fn receive(reader: &mut impl BufRead) -> io::Result<Value> {
    let mut text = String::new();
    if reader.read_line(&mut text)? == 0 {
        return Err(io::ErrorKind::UnexpectedEof.into());
    }
    serde_json::from_str(&text).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

/// A handshake line, at most [`HANDSHAKE_LIMIT`] bytes.
fn receive_short(reader: &mut BufReader<impl Read>) -> io::Result<Value> {
    receive(&mut reader.take(HANDSHAKE_LIMIT))
}

fn text<'a>(message: &'a Value, name: &str) -> &'a str {
    message.get(name).and_then(Value::as_str).unwrap_or_default()
}

fn size(message: &Value) -> Option<(u16, u16)> {
    let field = |name| {
        message
            .get(name)
            .and_then(Value::as_u64)
            .and_then(|n| u16::try_from(n).ok())
            .filter(|n| *n > 0)
    };
    Some((field("cols")?, field("rows")?))
}

/// The output of one kept terminal, and the modes it left set.
#[derive(Debug, Default)]
struct History {
    text: String,
    modes: BTreeMap<u16, bool>,
    /// The start of a mode sequence split across two reads.
    partial: String,
}

impl History {
    fn push(&mut self, data: &str) {
        self.track(data);
        self.text.push_str(data);
        if self.text.len() > HISTORY_LIMIT {
            // Keep whole lines, so a replay never starts inside an escape sequence.
            let start = self.text.len() - HISTORY_LIMIT * 3 / 4;
            let cut = match self.text.as_bytes()[start..].iter().position(|byte| *byte == b'\n') {
                Some(at) => start + at + 1,
                None => (start..self.text.len())
                    .find(|at| self.text.is_char_boundary(*at))
                    .unwrap_or(self.text.len()),
            };
            self.text.drain(..cut);
        }
    }

    /// Records `ESC [ ? <modes> h` and `l` for [`TRACKED_MODES`].
    fn track(&mut self, data: &str) {
        let joined = std::mem::take(&mut self.partial) + data;
        let mut rest = joined.as_str();
        while let Some(at) = rest.find("\x1b[?") {
            let after = &rest[at + 3..];
            let Some(end) = after.find(|c: char| !(c.is_ascii_digit() || c == ';')) else {
                if after.len() < 64 {
                    self.partial = rest[at..].to_owned();
                }
                return;
            };
            let set = match after.as_bytes()[end] {
                b'h' => Some(true),
                b'l' => Some(false),
                _ => None,
            };
            if let Some(set) = set {
                for mode in after[..end].split(';').filter_map(|mode| mode.parse::<u16>().ok()) {
                    if TRACKED_MODES.contains(&mode) {
                        self.modes.insert(mode, set);
                    }
                }
            }
            rest = &after[end..];
        }
        if let Some(tail) = ["\x1b[", "\x1b"].into_iter().find(|tail| rest.ends_with(tail)) {
            self.partial = tail.to_owned();
        }
    }

    /// What a new view needs: a reset, the kept output without the queries a terminal answers (the
    /// answers would reach the shell as typed input), and the modes in force.
    fn replay(&self) -> String {
        let mut replay = String::from("\x1bc");
        replay.push_str(&without_queries(&self.text));
        for (mode, set) in &self.modes {
            replay.push_str(&format!("\x1b[?{mode}{}", if *set { 'h' } else { 'l' }));
        }
        replay
    }
}

/// `text` without the sequences that make a terminal answer: device status and attribute
/// requests, mode and version queries, window reports, OSC queries (`…;?`), and every DCS string.
fn without_queries(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut kept = String::with_capacity(text.len());
    let (mut copied, mut at) = (0, 0);
    while let Some(offset) = bytes[at..].iter().position(|byte| *byte == 0x1b) {
        let start = at + offset;
        let (end, query) = match bytes.get(start + 1) {
            Some(b'[') => {
                let mut end = start + 2;
                while end < bytes.len() && (0x30..=0x3f).contains(&bytes[end]) {
                    end += 1;
                }
                let parameters = &text[start + 2..end];
                let middle = end;
                while end < bytes.len() && (0x20..=0x2f).contains(&bytes[end]) {
                    end += 1;
                }
                let Some(&last) = bytes.get(end) else { break };
                let intermediates = &text[middle..end];
                let query = match last {
                    b'n' | b'c' | b't' => true,
                    b'p' => intermediates == "$",
                    b'q' => parameters.starts_with('>'),
                    b'u' => parameters.starts_with('?'),
                    _ => false,
                };
                (end + 1, query)
            }
            Some(b']') => {
                let Some((payload, end)) = string_end(bytes, start + 2) else {
                    break;
                };
                (end, text[start + 2..payload].ends_with('?'))
            }
            Some(b'P') => {
                let Some((_, end)) = string_end(bytes, start + 2) else {
                    break;
                };
                (end, true)
            }
            _ => (start + 1, false),
        };
        if query {
            kept.push_str(&text[copied..start]);
            copied = end;
        }
        at = end;
    }
    kept.push_str(&text[copied..]);
    kept
}

/// Where an OSC or DCS string that starts at `from` ends: its payload end and the index after its
/// terminator (BEL or `ESC \`).
fn string_end(bytes: &[u8], from: usize) -> Option<(usize, usize)> {
    let mut at = from;
    while at < bytes.len() {
        match bytes[at] {
            0x07 => return Some((at, at + 1)),
            0x1b if bytes.get(at + 1) == Some(&b'\\') => return Some((at, at + 2)),
            _ => at += 1,
        }
    }
    None
}

// ---------------------------------------------------------------------------------------------
// The helper.

/// The connection an app is attached through.
struct Attached {
    id: u64,
    out: Sender<String>,
    stream: TcpStream,
    /// Replayed output the app has not acknowledged yet, in UTF-16 units.
    replay: usize,
    /// Live output the app has not acknowledged yet; the terminal's reader counts it too.
    owed: usize,
}

impl Attached {
    fn send(&self, message: &Value) {
        let _ = self.out.send(line(message));
    }
}

struct Kept {
    generation: u64,
    process: Box<dyn Process>,
    pid: Option<u32>,
    shell: String,
    integration: Option<Value>,
    history: History,
    attached: Option<Attached>,
}

impl Kept {
    /// Lets the terminal run on unwatched: what the app never acknowledged is acknowledged now.
    fn detach(&mut self) {
        if let Some(attached) = self.attached.take() {
            self.process.acknowledge(attached.owed);
            let _ = attached.stream.shutdown(Shutdown::Both);
        }
    }
}

#[derive(Default)]
struct Terminals {
    kept: HashMap<String, Kept>,
    connections: usize,
    generation: u64,
    /// Since when the helper has had nothing to do.
    idle_since: Option<Instant>,
    closing: bool,
}

impl Terminals {
    fn touch(&mut self) {
        let idle = self.kept.is_empty() && self.connections == 0;
        match (idle, self.idle_since) {
            (true, None) => self.idle_since = Some(Instant::now()),
            (false, Some(_)) => self.idle_since = None,
            _ => {}
        }
    }

    fn current(&mut self, key: &SessionKey) -> Option<&mut Kept> {
        self.kept
            .get_mut(&key.id)
            .filter(|kept| kept.generation == key.generation)
    }
}

struct Server {
    secret: String,
    terminals: Mutex<Terminals>,
    attachments: AtomicU64,
}

/// Runs the helper until it has been idle for [`IDLE_EXIT`]. `state` names the file that tells the
/// app where to connect.
pub fn serve(state: &Path) -> io::Result<()> {
    serve_until_idle(state, IDLE_EXIT)
}

/// [`serve`], exiting after `idle` without terminals or connections.
pub fn serve_until_idle(state_file: &Path, idle: Duration) -> io::Result<()> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let server = Arc::new(Server {
        secret: random(),
        terminals: Mutex::new(Terminals {
            idle_since: Some(Instant::now()),
            ..Terminals::default()
        }),
        attachments: AtomicU64::new(0),
    });
    let state = State {
        protocol: PROTOCOL,
        port: listener.local_addr()?.port(),
        pid: std::process::id(),
        secret: server.secret.clone(),
    };
    if let Some(folder) = state_file.parent() {
        fs::create_dir_all(folder)?;
    }
    let text = serde_json::to_string(&state).map_err(io::Error::other)?;
    atomic::write(state_file, text.as_bytes(), Access::Private)?;
    let accepting = Arc::clone(&server);
    thread::Builder::new().name("tc-daemon-accept".into()).spawn(move || {
        for stream in listener.incoming() {
            if accepting.lock().closing {
                break;
            }
            let (Ok(stream), server) = (stream, Arc::clone(&accepting)) else {
                continue;
            };
            let _ = thread::Builder::new()
                .name("tc-daemon-client".into())
                .spawn(move || server.connection(stream));
        }
    })?;
    loop {
        thread::sleep(Duration::from_millis(200));
        let mut terminals = server.lock();
        if terminals.idle_since.is_some_and(|since| since.elapsed() >= idle) {
            terminals.closing = true;
            break;
        }
    }
    // A newer helper may have replaced the file.
    if read_state(state_file).as_ref() == Some(&state) {
        let _ = fs::remove_file(state_file);
    }
    Ok(())
}

impl Server {
    fn lock(&self) -> MutexGuard<'_, Terminals> {
        self.terminals.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn connection(self: Arc<Self>, stream: TcpStream) {
        {
            let mut terminals = self.lock();
            if terminals.closing {
                return;
            }
            terminals.connections += 1;
            terminals.touch();
        }
        let _ = self.serve_connection(stream);
        let mut terminals = self.lock();
        terminals.connections -= 1;
        terminals.touch();
    }

    fn serve_connection(self: &Arc<Self>, stream: TcpStream) -> io::Result<()> {
        stream.set_nodelay(true)?;
        stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT))?;
        let mut writer = stream.try_clone()?;
        let mut reader = BufReader::new(stream.try_clone()?);
        let hello = receive_short(&mut reader)?;
        let nonce = text(&hello, "nonce");
        if hello.get("protocol") != Some(&json!(PROTOCOL)) {
            return send(&mut writer, &json!({ "protocol": PROTOCOL, "error": MISMATCH }));
        }
        if nonce.len() < 32 {
            return Ok(());
        }
        let challenge = random();
        send(
            &mut writer,
            &json!({ "protocol": PROTOCOL, "proof": proof(&self.secret, "server", nonce), "nonce": challenge }),
        )?;
        let answer = receive_short(&mut reader)?;
        if !same(text(&answer, "proof"), &proof(&self.secret, "client", &challenge)) {
            return Ok(());
        }
        // On Windows a cloned socket keeps its own timeout, so clear it where the reading happens.
        reader.get_ref().set_read_timeout(None)?;
        let request = receive(&mut reader)?;
        let card = text(&request, "id");
        if !matches!(text(&request, "op"), "list") && (card.is_empty() || card.len() > CARD_LIMIT) {
            return send(&mut writer, &json!({ "error": "Invalid terminal." }));
        }
        match text(&request, "op") {
            "list" => send(&mut writer, &self.list()),
            "kill" => {
                if let Some(kept) = self.lock().kept.get_mut(card) {
                    kept.process.kill();
                }
                send(&mut writer, &json!({ "ok": true }))
            }
            "create" => self.create(card, &request, stream, writer, reader),
            "attach" => self.attach(card, &request, stream, writer, reader),
            _ => send(&mut writer, &json!({ "error": "Unknown request." })),
        }
    }

    fn list(&self) -> Value {
        let terminals = self.lock();
        let kept: Vec<Value> = terminals
            .kept
            .iter()
            .map(|(id, kept)| json!({ "id": id, "pid": kept.pid, "integration": kept.integration }))
            .collect();
        json!({ "terminals": kept })
    }

    /// Starts writing to an attached app.
    fn attachment(&self, stream: &TcpStream) -> io::Result<Attached> {
        let (out, lines) = mpsc::channel();
        let writer = stream.try_clone()?;
        thread::Builder::new()
            .name("tc-daemon-write".into())
            .spawn(move || write_lines(&writer, &lines, None))?;
        Ok(Attached {
            id: self.attachments.fetch_add(1, Ordering::SeqCst),
            out,
            stream: stream.try_clone()?,
            replay: 0,
            owed: 0,
        })
    }

    fn create(
        self: &Arc<Self>,
        card: &str,
        request: &Value,
        stream: TcpStream,
        mut writer: TcpStream,
        reader: BufReader<TcpStream>,
    ) -> io::Result<()> {
        let spawn = request.get("spawn").cloned().unwrap_or_default();
        let Ok(spawn) = serde_json::from_value::<Spawn>(spawn) else {
            return send(&mut writer, &json!({ "error": "Invalid terminal." }));
        };
        let mut terminals = self.lock();
        if terminals.closing {
            return send(
                &mut writer,
                &json!({ "error": "The helper is closing.", "closing": true }),
            );
        }
        if terminals.kept.contains_key(card) {
            return send(&mut writer, &json!({ "error": "This terminal is already running." }));
        }
        terminals.generation += 1;
        let key = SessionKey {
            id: card.to_owned(),
            generation: terminals.generation,
        };
        let shell = spawn.shell.clone();
        let events = sink(Arc::downgrade(self));
        // The terminal's reader waits for this lock before it reports any output.
        let process = match PtyBackend.spawn(&spawn.into(), key.clone(), events) {
            Ok(process) => process,
            Err(error) => return send(&mut writer, &json!({ "error": error.to_string() })),
        };
        let attached = self.attachment(&stream)?;
        let id = attached.id;
        let pid = process.pid();
        attached.send(&json!({ "ok": true, "pid": pid, "shell": shell, "supportsIdle": true }));
        terminals.kept.insert(
            card.to_owned(),
            Kept {
                generation: key.generation,
                process,
                pid,
                shell,
                integration: request.get("integration").filter(|saved| !saved.is_null()).cloned(),
                history: History::default(),
                attached: Some(attached),
            },
        );
        terminals.touch();
        drop(terminals);
        self.read_client(card, id, reader);
        Ok(())
    }

    fn attach(
        self: &Arc<Self>,
        card: &str,
        request: &Value,
        stream: TcpStream,
        mut writer: TcpStream,
        reader: BufReader<TcpStream>,
    ) -> io::Result<()> {
        let Some((cols, rows)) = size(request) else {
            return send(&mut writer, &json!({ "error": "Invalid terminal dimensions." }));
        };
        let mut terminals = self.lock();
        let Some(kept) = terminals.kept.get_mut(card) else {
            return send(&mut writer, &json!({ "error": "This terminal is no longer running." }));
        };
        let mut attached = self.attachment(&stream)?;
        let id = attached.id;
        // Another view takes over; the earlier one ends.
        if let Some(previous) = kept.attached.take() {
            kept.process.acknowledge(previous.owed);
            // Let the writer drain this notice before it shuts down the connection.
            previous.send(&json!({ "t": "superseded" }));
        }
        attached.send(&json!({
            "ok": true,
            "pid": kept.pid,
            "shell": kept.shell,
            "integration": kept.integration,
            "supportsIdle": true,
        }));
        let replay = kept.history.replay();
        attached.replay = utf16_len(&replay);
        attached.send(&json!({ "t": "out", "d": replay }));
        kept.attached = Some(attached);
        // ConPTY repaints the whole screen on every resize, even to the same size.
        let _ = kept.process.resize(cols, rows);
        drop(terminals);
        self.read_client(card, id, reader);
        Ok(())
    }

    /// Handles an attached app's input until it detaches.
    fn read_client(&self, card: &str, attachment: u64, mut reader: BufReader<TcpStream>) {
        while let Ok(message) = receive(&mut reader) {
            let mut terminals = self.lock();
            let Some(kept) = terminals
                .kept
                .get_mut(card)
                .filter(|kept| kept.attached.as_ref().is_some_and(|attached| attached.id == attachment))
            else {
                return;
            };
            match text(&message, "t") {
                "in" => {
                    let _ = kept.process.write(text(&message, "d"));
                }
                "resize" => {
                    if let Some((cols, rows)) = size(&message) {
                        let _ = kept.process.resize(cols, rows);
                    }
                }
                "ack" => {
                    let units = message.get("n").and_then(Value::as_u64).unwrap_or_default();
                    let mut units = usize::try_from(units).unwrap_or(usize::MAX);
                    if let Some(attached) = &mut kept.attached {
                        let replayed = units.min(attached.replay);
                        attached.replay -= replayed;
                        units -= replayed;
                        let live = units.min(attached.owed);
                        attached.owed -= live;
                        kept.process.acknowledge(live);
                    }
                }
                _ => {}
            }
        }
        let mut terminals = self.lock();
        if let Some(kept) = terminals.kept.get_mut(card)
            && kept.attached.as_ref().is_some_and(|attached| attached.id == attachment)
        {
            kept.detach();
        }
    }

    fn event(&self, key: &SessionKey, event: SessionEvent) {
        let mut terminals = self.lock();
        match event {
            SessionEvent::Output(data) => {
                let Some(kept) = terminals.current(key) else { return };
                kept.history.push(&data);
                let units = utf16_len(&data);
                match &mut kept.attached {
                    Some(attached) => {
                        attached.owed += units;
                        attached.send(&json!({ "t": "out", "d": data }));
                    }
                    None => kept.process.acknowledge(units),
                }
            }
            SessionEvent::Exit(status) => {
                if terminals.current(key).is_none() {
                    return;
                }
                let Some(kept) = terminals.kept.remove(&key.id) else {
                    return;
                };
                terminals.touch();
                drop(terminals);
                match &kept.attached {
                    Some(attached) => attached.send(&json!({ "t": "exit", "code": status.code })),
                    None => {
                        if let Some(integration) = kept.integration.as_ref().and_then(Integration::restore) {
                            integration.cleanup();
                        }
                    }
                }
            }
            SessionEvent::Directory(_) | SessionEvent::Report(_) | SessionEvent::Superseded => {}
        }
    }
}

fn sink(server: Weak<Server>) -> EventSink {
    Arc::new(move |key, event| {
        if let Some(server) = server.upgrade() {
            server.event(&key, event);
        }
    })
}

/// Writes queued lines, several at a time, until the queue or the connection closes.
fn write_lines(mut stream: &TcpStream, lines: &Receiver<String>, keepalive: Option<Duration>) {
    let next = || match keepalive {
        Some(interval) => match lines.recv_timeout(interval) {
            Ok(message) => Some(message),
            Err(mpsc::RecvTimeoutError::Timeout) => Some(line(&json!({ "t": "keep-alive" }))),
            Err(mpsc::RecvTimeoutError::Disconnected) => None,
        },
        None => lines.recv().ok(),
    };
    while let Some(mut batch) = next() {
        while batch.len() < WRITE_BATCH
            && let Ok(more) = lines.try_recv()
        {
            batch.push_str(&more);
        }
        if stream.write_all(batch.as_bytes()).is_err() {
            break;
        }
    }
    let _ = stream.shutdown(Shutdown::Both);
}

/// [`SpawnRequest`] as sent to the helper.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Spawn {
    shell: String,
    args: Vec<String>,
    cwd: String,
    cols: u16,
    rows: u16,
    env: BTreeMap<String, String>,
}

impl From<&SpawnRequest> for Spawn {
    fn from(request: &SpawnRequest) -> Self {
        Spawn {
            shell: request.shell.clone(),
            args: request.args.clone(),
            cwd: request.cwd.clone(),
            cols: request.cols,
            rows: request.rows,
            env: request.env.clone(),
        }
    }
}

impl From<Spawn> for SpawnRequest {
    fn from(spawn: Spawn) -> Self {
        SpawnRequest {
            shell: spawn.shell,
            args: spawn.args,
            cwd: spawn.cwd,
            cols: spawn.cols,
            rows: spawn.rows,
            env: spawn.env,
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The app's side.

/// A terminal the helper keeps.
#[derive(Debug, Clone)]
pub struct KeptTerminal {
    pub id: String,
    pub integration: Option<Integration>,
}

/// An attached terminal, from [`Daemon::create`] or [`Daemon::attach`].
pub struct Attachment {
    pub process: Box<dyn Process>,
    /// The shell the helper runs.
    pub shell: String,
}

/// Starts the helper when needed and talks to it.
#[derive(Debug, Clone)]
pub struct Daemon {
    /// The `tc-hook` executable. The helper runs from a copy (see [`Daemon::program`]).
    hook: PathBuf,
    /// Holds the state file and the helper's copy.
    folder: PathBuf,
}

impl Daemon {
    pub fn new(hook: PathBuf, folder: PathBuf) -> Self {
        Daemon { hook, folder }
    }

    /// Where the helper says how to reach it; [`serve`] takes this path.
    pub fn state_file(&self) -> PathBuf {
        self.folder.join("helper.json")
    }

    /// Connects to the running helper, if any.
    fn connect(&self) -> io::Result<Connection> {
        let state = read_state(&self.state_file())
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "The terminal helper is not running."))?;
        Connection::open(&state)
    }

    /// The terminals the helper keeps; none when it is not running.
    pub fn terminals(&self) -> Vec<KeptTerminal> {
        let Ok(reply) = self
            .connect()
            .and_then(|connection| connection.request(&json!({ "op": "list" })))
        else {
            return Vec::new();
        };
        reply
            .1
            .get("terminals")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|kept| KeptTerminal {
                id: text(kept, "id").to_owned(),
                integration: kept.get("integration").and_then(Integration::restore),
            })
            .collect()
    }

    /// Ends a kept terminal and everything it started.
    pub fn kill(&self, card: &str) {
        if let Ok(connection) = self.connect() {
            let _ = connection.request(&json!({ "op": "kill", "id": card }));
        }
    }

    /// Starts a terminal in the helper, starting the helper first when needed, and attaches to it.
    pub fn create(
        &self,
        card: &str,
        request: &SpawnRequest,
        integration: Option<&Integration>,
        key: SessionKey,
        events: EventSink,
    ) -> io::Result<Attachment> {
        let message = json!({
            "op": "create",
            "id": card,
            "spawn": Spawn::from(request),
            "integration": integration.map(Integration::saved),
        });
        // A helper that is gone, or is just exiting, is replaced once.
        let reply = match self.connect().and_then(|connection| connection.request(&message)) {
            Err(error) if error.kind() != io::ErrorKind::Other => {
                self.start()?;
                self.connect()?.request(&message)
            }
            reply => reply,
        }?;
        attachment(reply, key, events)
    }

    /// Attaches to a kept terminal, which then repaints at `cols` × `rows`.
    pub fn attach(
        &self,
        card: &str,
        cols: u16,
        rows: u16,
        key: SessionKey,
        events: EventSink,
    ) -> io::Result<Attachment> {
        let reply = self
            .connect()?
            .request(&json!({ "op": "attach", "id": card, "cols": cols, "rows": rows }))?;
        attachment(reply, key, events)
    }

    /// Starts a helper and waits until it is listening.
    fn start(&self) -> io::Result<()> {
        fs::create_dir_all(&self.folder)?;
        let program = self.program()?;
        let mut command = Command::new(program);
        command
            .arg(COMMAND)
            .arg(self.state_file())
            .current_dir(&self.folder)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = spawn_detached(&mut command)?;
        let deadline = Instant::now() + START_TIMEOUT;
        while Instant::now() < deadline {
            if read_state(&self.state_file()).is_some_and(|state| state.pid == child.id()) {
                return Ok(());
            }
            if let Some(status) = child.try_wait()? {
                return Err(io::Error::other(format!(
                    "The terminal helper exited at startup ({status})."
                )));
            }
            thread::sleep(Duration::from_millis(20));
        }
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "The terminal helper did not start.",
        ))
    }

    /// The executable the helper runs from. On Windows that is a copy of `tc-hook` named by its
    /// contents, because a running program cannot be replaced: an update must still be able to
    /// replace the installed `tc-hook` while terminals keep running.
    #[cfg(windows)]
    fn program(&self) -> io::Result<PathBuf> {
        let bytes = fs::read(&self.hook)?;
        let name = format!("tc-hook-{}.exe", hex(&Sha256::digest(&bytes)[..8]));
        let program = self.folder.join(&name);
        if !program.is_file() {
            atomic::write(&program, &bytes, Access::Default)?;
        }
        // Earlier copies go once no helper runs from them.
        for entry in fs::read_dir(&self.folder)?.flatten() {
            let file = entry.file_name().to_string_lossy().into_owned();
            if file.starts_with("tc-hook-") && file.ends_with(".exe") && file != name {
                let _ = fs::remove_file(entry.path());
            }
        }
        Ok(program)
    }

    #[cfg(not(windows))]
    fn program(&self) -> io::Result<PathBuf> {
        Ok(self.hook.clone())
    }
}

/// The app's end of a connection, shared by the threads that read and write it.
///
/// It is one socket handle, never a clone. On Windows a clone taken while the connection is still
/// completing can keep the unconnected state for good: it reads and writes, but its `shutdown`
/// fails (WSAENOTCONN) without reaching the helper, which then kept a detached view open.
#[derive(Clone)]
struct Socket(Arc<TcpStream>);

impl Deref for Socket {
    type Target = TcpStream;

    fn deref(&self) -> &TcpStream {
        &self.0
    }
}

impl Read for Socket {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        (&*self.0).read(buf)
    }
}

impl Write for Socket {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        (&*self.0).write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        (&*self.0).flush()
    }
}

/// An authenticated connection to the helper.
struct Connection {
    writer: Socket,
    reader: BufReader<Socket>,
}

impl Connection {
    fn new(stream: TcpStream) -> Self {
        let socket = Socket(Arc::new(stream));
        Connection {
            writer: socket.clone(),
            reader: BufReader::new(socket),
        }
    }

    fn open(state: &State) -> io::Result<Self> {
        if state.protocol != PROTOCOL {
            return Err(io::Error::other(MISMATCH));
        }
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, state.port));
        let stream = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT)?;
        stream.set_nodelay(true)?;
        stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT))?;
        let mut connection = Connection::new(stream);
        let nonce = random();
        send(&mut connection.writer, &json!({ "protocol": PROTOCOL, "nonce": nonce }))?;
        let hello = receive_short(&mut connection.reader)?;
        if hello.get("protocol") != Some(&json!(PROTOCOL)) {
            return Err(io::Error::other(MISMATCH));
        }
        if !same(text(&hello, "proof"), &proof(&state.secret, "server", &nonce)) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Another program is listening where the terminal helper was.",
            ));
        }
        let answer = proof(&state.secret, "client", text(&hello, "nonce"));
        send(&mut connection.writer, &json!({ "proof": answer }))?;
        Ok(connection)
    }

    /// Sends `request` and reads the reply. A refusal is an [`io::ErrorKind::Other`] error, except
    /// from a helper that is exiting, which is [`io::ErrorKind::ConnectionAborted`].
    fn request(mut self, request: &Value) -> io::Result<(Self, Value)> {
        send(&mut self.writer, request)?;
        let reply = receive(&mut self.reader)?;
        if let Some(error) = reply.get("error").and_then(Value::as_str) {
            if reply.get("closing") == Some(&Value::Bool(true)) {
                return Err(io::Error::new(io::ErrorKind::ConnectionAborted, error));
            }
            return Err(io::Error::other(error));
        }
        Ok((self, reply))
    }
}

/// Turns an attached connection into a [`Process`] that reports to `events`.
fn attachment((connection, reply): (Connection, Value), key: SessionKey, events: EventSink) -> io::Result<Attachment> {
    let Connection { writer, mut reader } = connection;
    reader.get_ref().set_read_timeout(None)?;
    let pid = reply
        .get("pid")
        .and_then(Value::as_u64)
        .and_then(|pid| u32::try_from(pid).ok());
    let shell = text(&reply, "shell").to_owned();
    let (input, lines) = mpsc::channel();
    let output = writer.clone();
    // Older helpers ignore this frame, but reading it keeps their handshake timeout from firing.
    let keepalive = (reply.get("supportsIdle") != Some(&Value::Bool(true))).then_some(LEGACY_KEEPALIVE);
    thread::Builder::new()
        .name("tc-daemon-input".into())
        .spawn(move || write_lines(&output, &lines, keepalive))?;
    let detached = Arc::new(AtomicBool::new(false));
    let ended = Arc::clone(&detached);
    thread::Builder::new().name("tc-daemon-output".into()).spawn(move || {
        let mut status = None;
        let mut superseded = false;
        while let Ok(message) = receive(&mut reader) {
            match text(&message, "t") {
                "out" => events(key.clone(), SessionEvent::Output(text(&message, "d").to_owned())),
                "exit" => {
                    let code = message.get("code").and_then(Value::as_i64).unwrap_or_default();
                    status = Some(ExitStatus { code, signal: None });
                    break;
                }
                "superseded" => {
                    superseded = true;
                    break;
                }
                _ => {}
            }
        }
        // Close this side too: on Windows the helper's shutdown does not wake its own blocked read
        // on a cloned socket, so its connection would otherwise stay open until the app's ends.
        let _ = reader.get_ref().shutdown(Shutdown::Both);
        if superseded {
            events(key, SessionEvent::Superseded);
            return;
        }
        // Detaching ends the view without an error; a lost helper ends it with one.
        let code = if ended.load(Ordering::SeqCst) { 0 } else { 1 };
        let status = status.unwrap_or(ExitStatus { code, signal: None });
        events(key, SessionEvent::Exit(status));
    })?;
    Ok(Attachment {
        process: Box::new(AttachedProcess {
            pid,
            input,
            stream: writer,
            detached,
        }),
        shell,
    })
}

/// A terminal in the helper, seen through one connection. Killing it detaches; the terminal keeps
/// running until [`Daemon::kill`].
struct AttachedProcess {
    pid: Option<u32>,
    input: Sender<String>,
    stream: Socket,
    detached: Arc<AtomicBool>,
}

impl AttachedProcess {
    fn send(&self, message: &Value) -> io::Result<()> {
        self.input
            .send(line(message))
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "The terminal is no longer accepting input."))
    }
}

impl Process for AttachedProcess {
    fn pid(&self) -> Option<u32> {
        self.pid
    }

    fn write(&mut self, data: &str) -> io::Result<()> {
        self.send(&json!({ "t": "in", "d": data }))
    }

    fn resize(&mut self, cols: u16, rows: u16) -> io::Result<()> {
        self.send(&json!({ "t": "resize", "cols": cols, "rows": rows }))
    }

    // The helper applies the watermarks to the terminal it reads.
    fn pause(&mut self) {}

    fn resume(&mut self) {}

    fn acknowledge(&mut self, units: usize) {
        let _ = self.send(&json!({ "t": "ack", "n": units }));
    }

    fn kill(&mut self) {
        self.detached.store(true, Ordering::SeqCst);
        let _ = self.stream.shutdown(Shutdown::Both);
    }
}

impl Drop for AttachedProcess {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Starts the helper outside the app's process job when the job allows it, without a console
/// window, so it outlives the app.
#[cfg(windows)]
fn spawn_detached(command: &mut Command) -> io::Result<Child> {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB);
    match command.spawn() {
        // A job that forbids breaking away refuses the flag; the app is then not in a job of its own.
        Err(error) if error.raw_os_error() == Some(5) => {
            command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
            command.spawn()
        }
        result => result,
    }
}

#[cfg(not(windows))]
fn spawn_detached(command: &mut Command) -> io::Result<Child> {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
    command.spawn()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proofs_depend_on_the_secret_the_role_and_the_nonce() {
        let base = proof("secret", "server", "nonce");
        assert_eq!(base.len(), 64);
        assert_ne!(base, proof("other", "server", "nonce"));
        assert_ne!(base, proof("secret", "client", "nonce"));
        assert_ne!(base, proof("secret", "server", "other"));
        assert!(same(&base, &proof("secret", "server", "nonce")));
    }

    #[test]
    fn a_legacy_attachment_keeps_sending_while_idle() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let stream = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (peer, _) = listener.accept().unwrap();
        peer.set_read_timeout(Some(HANDSHAKE_TIMEOUT)).unwrap();
        let mut peer = BufReader::new(peer);
        let mut attached = attachment(
            (Connection::new(stream), json!({ "ok": true, "shell": "test" })),
            SessionKey {
                id: "legacy".into(),
                generation: 1,
            },
            Arc::new(|_, _| {}),
        )
        .unwrap();

        // This outlasts the old helper's timeout while the terminal has no input or output.
        for _ in 0..3 {
            assert_eq!(receive(&mut peer).unwrap(), json!({ "t": "keep-alive" }));
        }
        attached.process.write("echo still here\r").unwrap();
        assert_eq!(
            receive(&mut peer).unwrap(),
            json!({ "t": "in", "d": "echo still here\r" })
        );
    }

    /// The helper lets a view go only once it sees the app's end of the connection, so detaching
    /// must reach it while the app still holds the attachment.
    #[test]
    fn detaching_reaches_the_helper_and_ends_the_view_without_an_error() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let stream = TcpStream::connect_timeout(&listener.local_addr().unwrap(), CONNECT_TIMEOUT).unwrap();
        stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT)).unwrap();
        let (peer, _) = listener.accept().unwrap();
        peer.set_read_timeout(Some(HANDSHAKE_TIMEOUT)).unwrap();
        let (sender, events) = mpsc::channel();
        let mut attached = attachment(
            (
                Connection::new(stream),
                json!({ "ok": true, "shell": "test", "supportsIdle": true }),
            ),
            SessionKey {
                id: "detached".into(),
                generation: 1,
            },
            Arc::new(move |_, event| {
                let _ = sender.send(event);
            }),
        )
        .unwrap();

        attached.process.kill();
        let mut rest = Vec::new();
        (&peer).read_to_end(&mut rest).expect("the helper sees the app hang up");
        assert!(rest.is_empty());
        drop(peer);
        assert_eq!(
            events.recv_timeout(HANDSHAKE_TIMEOUT),
            Ok(SessionEvent::Exit(ExitStatus { code: 0, signal: None }))
        );
    }

    #[test]
    fn replays_drop_queries_and_keep_everything_else() {
        let text = "a\x1b[6nb\x1b[>0cc\x1b[?2004$pd\x1b[>0qe\x1b]11;?\x07f\x1bP$qm\x1b\\g\x1b[31mh\x1b]0;title\x07i\x1b[18tj\x1b[?u";
        assert_eq!(without_queries(text), "abcdefg\x1b[31mh\x1b]0;title\x07ij");
        // An unfinished sequence at the end is kept as it is.
        assert_eq!(without_queries("x\x1b]0;unterminated"), "x\x1b]0;unterminated");
        assert_eq!(without_queries("x\x1b["), "x\x1b[");
    }

    #[test]
    fn history_tracks_modes_across_reads_and_restores_them_after_a_reset() {
        let mut history = History::default();
        history.push("one\r\n\x1b[?1049h\x1b[?25");
        history.push("l\x1b[?2004h\x1b");
        history.push("[?2004l\x1b[?1;9001h two\x1b[6n");
        assert_eq!(
            history.modes,
            BTreeMap::from([(1, true), (25, false), (1049, true), (2004, false)])
        );
        let replay = history.replay();
        assert!(replay.starts_with("\x1bcone\r\n"));
        assert!(!replay.contains("\x1b[6n"));
        assert!(replay.ends_with("\x1b[?1h\x1b[?25l\x1b[?1049h\x1b[?2004l"));
    }

    #[test]
    fn history_keeps_whole_recent_lines_within_its_limit() {
        let mut history = History::default();
        let row = format!("{}\r\n", "é".repeat(99));
        for _ in 0..(2 * HISTORY_LIMIT / row.len()) {
            history.push(&row);
        }
        assert!(history.text.len() <= HISTORY_LIMIT);
        assert!(history.text.len() >= HISTORY_LIMIT / 2);
        assert!(history.text.starts_with('é') && history.text.ends_with("\r\n"));
        // Output without line breaks is cut at a character boundary.
        let mut history = History::default();
        history.push(&"é".repeat(HISTORY_LIMIT));
        assert!(history.text.len() <= HISTORY_LIMIT && history.text.starts_with('é'));
    }
}
