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
use tc_core::workspace::{PROFILES, Workspace, create_card, create_workspace, limits, validate_workspace};
use tc_core::{Error, Platform as Os};
use tc_pty::manager::{Backend, Config, DirectoryRequest, EventSink, Integrations, STOP_TIMEOUT};
use tc_pty::{SessionEvent, SessionKey, TerminalEvent, TerminalManager};

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

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

/// Where the host keeps its files: the folder the Electron build used, so they carry over.
#[derive(Debug, Clone)]
pub struct Paths {
    pub data: PathBuf,
    /// The `tc-hook` sidecar. Without it, shells run without AI session capture.
    pub hook: Option<PathBuf>,
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
    /// Where programs outside the canvas ask for new terminals (see [`tc_core::launch`]).
    pub fn launch_requests(&self) -> PathBuf {
        tc_core::launch::app_inbox(&self.data)
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
    manager: TerminalManager,
    recovery: WorkspaceRecovery,
    filename: Option<PathBuf>,
    inputs: HashMap<String, InputOrder>,
    launches: crate::launches::Launches,
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
    quitting: AtomicBool,
}

type CommandResult = Result<Value, String>;

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn field<'a>(payload: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    payload?.as_object()?.get(key)
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
    pub fn new(paths: Paths, platform: Arc<dyn Platform>, backend: Box<dyn Backend>, config: Config) -> Arc<Host> {
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
        let mut state = State {
            manager: TerminalManager::new(config, backend, integrations, sink),
            recovery: WorkspaceRecovery::new(),
            filename: None,
            inputs: HashMap::new(),
            launches: crate::launches::Launches::new(),
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
                        host.poll_launch_requests(&mut state);
                    }
                    None => break,
                }
                host.dispatch(&mut state);
            }
        });
        host
    }

    fn post(&self, task: impl FnOnce(&Host, &mut State) + Send + 'static) {
        let _ = self.state.send(Message::Task(Box::new(task)));
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

    fn emit(&self, event: Value) {
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
        for event in state.manager.take_events() {
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
            self.emit(serde_json::to_value(&event).expect("events serialize"));
        }
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
        self.with_state(|_, state| state.manager.begin_shutdown(STOP_TIMEOUT))
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
                if utf16_len(&text) > 64_000 {
                    return Err("Paste is limited to 64,000 characters.".into());
                }
                Ok(json!({ "text": text }))
            }
            "clipboard-write" => {
                let Some(Value::String(text)) =
                    payload.filter(|text| text.as_str().is_some_and(|t| utf16_len(t) <= 1024 * 1024))
                else {
                    return Err("Selection exceeds 1 MB.".into());
                };
                self.platform.write_clipboard(text.clone()).await?;
                Ok(json!({ "ok": true }))
            }
            "initialize" => {
                let mut workspace = create_workspace();
                let mut warning = None;
                match self.read_workspace(&self.paths.recovery()).await {
                    Ok(restored) => workspace = restored,
                    Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => warning = Some(format!("Could not restore your last workspace: {error}")),
                }
                let restored = workspace.clone();
                self.with_state(move |_, state| {
                    state.recovery.reset(restored);
                    state.inputs.clear();
                })
                .await;
                let mut result = json!({
                    "workspace": workspace, "profiles": PROFILES, "home": self.home, "platform": node_platform(self.os)
                });
                if let Some(warning) = warning {
                    result["warning"] = json!(warning);
                }
                Ok(result)
            }
            "create-card" => Ok(json!({ "card": create_card(payload.unwrap_or(&Value::Null)).map_err(message)? })),
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
                        let card = state
                            .recovery
                            .remember_card(field(payload, "card").unwrap_or(&Value::Null))
                            .map_err(message)?;
                        let raw = serde_json::to_value(&card).expect("cards serialize");
                        // A terminal a program asked for logs its output from the first byte.
                        if let Some(request) = field(payload, "launch").and_then(Value::as_str) {
                            state.launches.begin_output(request, &card.id);
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
                    self.with_state(move |_, state| state.manager.stop(&id)).await;
                    return Err(error);
                }
                Ok(json!(started))
            }
            "launch-result" => {
                let (request, card, error) = crate::launches::parse_result(payload)?;
                let answered = self
                    .with_state(move |_, state| state.launches.answer(&request, card.as_deref(), error.as_deref()))
                    .await;
                Ok(json!({ "ok": answered }))
            }
            "stop" => {
                if let Some(id) = field(payload, "id").and_then(Value::as_str) {
                    let id = id.to_owned();
                    self.with_state(move |_, state| state.manager.stop(&id)).await;
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
                        let merged = state.recovery.merge(&board.to_value()).map_err(message)?;
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
                        state.recovery.accept(&raw).cloned().map_err(message)
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
                        let merged = state.recovery.merge(&board.to_value()).map_err(message)?;
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
                self.with_state(move |host, state| {
                    state.manager.stop_all();
                    host.dispatch(state);
                    state.manager.forget();
                    state.recovery.reset(opened);
                })
                .await;
                self.flush(None).await?;
                self.with_state(move |_, state| state.filename = Some(file)).await;
                Ok(json!({ "workspace": workspace }))
            }
            "new" => {
                self.with_state(|host, state| {
                    state.manager.stop_all();
                    host.dispatch(state);
                    state.manager.forget();
                    state.filename = None;
                    state.recovery.reset(create_workspace());
                })
                .await;
                self.flush(None).await?;
                Ok(self
                    .with_state(|_, state| json!({ "workspace": state.recovery.board() }))
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
