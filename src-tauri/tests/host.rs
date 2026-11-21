//! OS boundary and recovery parity, exercised without a webview or real child processes.
use std::collections::VecDeque;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tc_core::workspace::{create_card, create_workspace};
use tc_pty::manager::{Backend, Config, EventSink, ExitStatus, Process, SessionEvent, SessionKey, SpawnRequest};
use tc_tmux::install::{Installed, Plan};
use terminal_canvas::host::{
    AgentHome, BoxFuture, FileKind, HELPER_MISSING, Host, NO_INTEGRATION, Paths, Platform, TmuxProbe, TmuxState,
};

#[derive(Default)]
struct FakePlatform {
    clipboard: Mutex<String>,
    read_failure: Mutex<Option<String>>,
    write_failure: Mutex<Option<String>>,
    write_gate: Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
    link_failure: Mutex<Option<String>>,
    links: Mutex<Vec<String>>,
    writes: AtomicUsize,
    closed: AtomicUsize,
    chosen: Mutex<VecDeque<Option<PathBuf>>>,
    defaults: Mutex<Vec<Option<PathBuf>>>,
    save_names: Mutex<Vec<String>>,
}
impl Platform for FakePlatform {
    fn pick_folder(&self, default: Option<PathBuf>) -> BoxFuture<Option<PathBuf>> {
        self.defaults.lock().unwrap().push(default);
        let chosen = self.chosen.lock().unwrap().pop_front().flatten();
        Box::pin(async move { chosen })
    }
    fn save_file(&self, _: &'static str, name: String) -> BoxFuture<Option<PathBuf>> {
        self.save_names.lock().unwrap().push(name);
        let chosen = self.chosen.lock().unwrap().pop_front().flatten();
        Box::pin(async move { chosen })
    }
    fn open_file(&self, _: &'static str, _: FileKind) -> BoxFuture<Option<PathBuf>> {
        let chosen = self.chosen.lock().unwrap().pop_front().flatten();
        Box::pin(async move { chosen })
    }
    fn read_clipboard(&self) -> BoxFuture<Result<String, String>> {
        let result = match self.read_failure.lock().unwrap().clone() {
            Some(error) => Err(error),
            None => Ok(self.clipboard.lock().unwrap().clone()),
        };
        Box::pin(async move { result })
    }
    fn write_clipboard(&self, text: String) -> BoxFuture<Result<(), String>> {
        if let Some(error) = self.write_failure.lock().unwrap().clone() {
            return Box::pin(async move { Err(error) });
        }
        self.writes.fetch_add(1, Ordering::SeqCst);
        *self.clipboard.lock().unwrap() = text;
        let gate = self.write_gate.lock().unwrap().take();
        Box::pin(async move {
            if let Some(gate) = gate {
                gate.await.map_err(|error| error.to_string())?;
            }
            Ok(())
        })
    }
    fn open_link(&self, url: String) -> BoxFuture<Result<(), String>> {
        self.links.lock().unwrap().push(url);
        let failure = self.link_failure.lock().unwrap().clone();
        Box::pin(async move { failure.map_or(Ok(()), Err) })
    }
    fn close_window(&self) {
        self.closed.fetch_add(1, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct FakeProcess {
    writes: Vec<String>,
    killed: bool,
    env: std::collections::BTreeMap<String, String>,
}
struct ProcessHandle {
    state: Arc<Mutex<FakeProcess>>,
    key: SessionKey,
    events: EventSink,
}
impl Process for ProcessHandle {
    fn pid(&self) -> Option<u32> {
        Some(123)
    }
    fn write(&mut self, data: &str) -> io::Result<()> {
        self.state.lock().unwrap().writes.push(data.to_owned());
        Ok(())
    }
    fn resize(&mut self, _: u16, _: u16) -> io::Result<()> {
        Ok(())
    }
    fn pause(&mut self) {}
    fn resume(&mut self) {}
    fn acknowledge(&mut self, _: usize) {}
    fn kill(&mut self) {
        self.state.lock().unwrap().killed = true;
        // An immediate exit must queue back to the actor, never re-enter a locked manager.
        (self.events)(
            self.key.clone(),
            SessionEvent::Exit(ExitStatus { code: 0, signal: None }),
        );
    }
}
type Launch = (SessionKey, EventSink, Arc<Mutex<FakeProcess>>);
#[derive(Default)]
struct FakeBackend(Arc<Mutex<Vec<Launch>>>);
impl Backend for FakeBackend {
    fn spawn(&mut self, request: &SpawnRequest, key: SessionKey, events: EventSink) -> io::Result<Box<dyn Process>> {
        let state = Arc::new(Mutex::new(FakeProcess {
            env: request.env.clone(),
            ..FakeProcess::default()
        }));
        self.0
            .lock()
            .unwrap()
            .push((key.clone(), events.clone(), state.clone()));
        Ok(Box::new(ProcessHandle { state, key, events }))
    }
    fn watch_directory(&mut self, _: u32, _: tc_core::Platform, _: SessionKey, _: EventSink) -> Box<dyn Send> {
        Box::new(())
    }
}
struct Harness {
    host: Arc<Host>,
    platform: Arc<FakePlatform>,
    launches: Arc<Mutex<Vec<Launch>>>,
    events: Arc<Mutex<Vec<Value>>>,
    folder: PathBuf,
}
impl Harness {
    /// A host without `tc-hook`, so terminals start without integration.
    fn new() -> Self {
        Self::with_hook(false)
    }
    /// With `hook`, the host is told `tc-hook` is in the test folder; nothing runs it unless a
    /// terminal starts.
    fn with_hook(hook: bool) -> Self {
        Self::build(hook, false, None)
    }
    /// With an agent home in the test folder that offers the setup on the first launch.
    fn with_agents() -> Self {
        Self::build(false, true, None)
    }
    /// With a tmux setup that sees what `probe` reports instead of this machine.
    fn with_tmux(probe: TmuxProbe) -> Self {
        Self::build(false, false, Some(probe))
    }
    fn build(hook: bool, agents: bool, tmux: Option<TmuxProbe>) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let folder = std::env::temp_dir().join(format!(
            "tc-host-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&folder).unwrap();
        let platform = Arc::new(FakePlatform::default());
        let backend = FakeBackend::default();
        let launches = backend.0.clone();
        let mut config = Config::from_environment();
        config.home = folder.to_string_lossy().into_owned();
        let host = Host::new(
            Paths {
                data: folder.clone(),
                hook: hook.then(|| folder.join("tc-hook")),
                agents: agents.then(|| AgentHome {
                    home: folder.join("home"),
                    claude_config: None,
                    first_launch: true,
                }),
                tmux,
            },
            platform.clone(),
            Box::new(backend),
            config,
        );
        let events = Arc::new(Mutex::new(Vec::new()));
        let received = events.clone();
        host.connect(Arc::new(move |event| received.lock().unwrap().push(event)));
        Self {
            host,
            platform,
            launches,
            events,
            folder,
        }
    }
    fn recovery(&self) -> PathBuf {
        self.folder.join("workspace.terminalcanvas")
    }
    fn read_saved(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.recovery()).unwrap()).unwrap()
    }
    async fn start(&self) -> Value {
        let card = json!(create_card(&json!({"cwd": self.folder})).unwrap());
        self.host
            .command("start", Some(&json!({"card": card, "cols": 80, "rows": 24})))
            .await
            .unwrap();
        card
    }
    async fn report_session(&self) {
        let (key, events, _) = self.launches.lock().unwrap()[0].clone();
        // A directory report does not require prompt integration and can be followed by a Claude launch.
        let report = json!({"type":"launch", "provider":"claude", "token":"abcdef01-1234-4321-9876-123456789abc",
            "sessionId":"12345678-1234-4321-9876-123456789abc", "cwd":self.folder});
        use base64::Engine;
        let encoded = base64::engine::general_purpose::STANDARD.encode(report.to_string());
        events(key, SessionEvent::Output(format!("\x1b]633;TC;{encoded}\x07")));
        self.host.running().await; // barrier after the report
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        // All tests await a write barrier before dropping. The actor has no strong Host reference
        // while idle; its next tick disposes processes, and queue workers finish before exiting.
        let _ = std::fs::remove_dir_all(&self.folder);
    }
}

#[tokio::test]
async fn title_edits_survive_stale_saves_export_import_and_restart_without_starting_terminals() {
    let h = Harness::new();
    let initial = h.host.command("initialize", None).await.unwrap();
    let card = create_card(&json!({"cwd":h.folder,"titleMode":"automatic"})).unwrap();
    let mut board = create_workspace().to_value();
    board["cards"] = json!([card]);
    h.host.command("autosave", Some(&board)).await.unwrap();
    let manual = h
        .host
        .command(
            "rename-title",
            Some(&json!({"id":card.id,"mode":"manual","title":"Release checks","titleEpoch":initial["titleEpoch"]})),
        )
        .await
        .unwrap();
    assert_eq!(manual["card"]["titleMode"], "manual");
    h.host.command("autosave", Some(&board)).await.unwrap();
    assert_eq!(h.read_saved()["cards"][0]["title"], "Release checks");
    let export = h.folder.join("portable.terminalcanvas");
    h.platform.chosen.lock().unwrap().push_back(Some(export.clone()));
    h.host.command("export", Some(&board)).await.unwrap();
    let exported: Value = serde_json::from_slice(&std::fs::read(&export).unwrap()).unwrap();
    assert_eq!(exported["cards"][0]["title"], "Release checks");
    h.host.command("new", None).await.unwrap();
    h.platform.chosen.lock().unwrap().push_back(Some(export));
    let imported = h.host.command("open", None).await.unwrap();
    assert_eq!(imported["workspace"]["cards"][0]["titleMode"], "manual");
    assert_eq!(h.host.running().await, 0);
    assert_eq!(h.host.command("rename-title", Some(&json!({"id":card.id,"mode":"manual","title":"Stale workspace edit","titleEpoch":initial["titleEpoch"]}))).await.unwrap_err(), "The workspace has changed.");
    let restored = h.host.command("initialize", None).await.unwrap();
    assert_eq!(restored["workspace"]["cards"][0]["title"], "Release checks");
    assert_eq!(h.host.running().await, 0);
    let automatic = h
        .host
        .command("rename-title", Some(&json!({"id":card.id,"mode":"automatic"})))
        .await
        .unwrap();
    assert_eq!(automatic["card"]["titleMode"], "automatic");
    assert!(automatic["card"]["title"].as_str().unwrap().ends_with(" · Terminal"));
}

#[tokio::test]
async fn automatic_titles_reach_attached_browsers_with_the_desktop_epoch_and_manual_precedence() {
    let h = Harness::new();
    let initial = h.host.command("initialize", None).await.unwrap();
    let mut card = create_card(&json!({"cwd":h.folder,"titleMode":"automatic"})).unwrap();
    card.claude_account = Some("Naming test".into());
    h.host
        .command("start", Some(&json!({"card":card,"cols":80,"rows":24})))
        .await
        .unwrap();
    let project: String = h
        .folder
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let folder = h
        .folder
        .join("claude-accounts")
        .join("Naming test")
        .join("projects")
        .join(project);
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(
        folder.join("12345678-1234-4321-9876-123456789abc.jsonl"),
        format!(
            "{}\n",
            json!({"sessionId":"12345678-1234-4321-9876-123456789abc","aiTitle":"Fix browser titles ไทย"})
        ),
    )
    .unwrap();
    let (snapshot, mut events) = h.host.remote_attach().await;
    assert_eq!(snapshot["titleEpoch"], initial["titleEpoch"]);
    h.report_session().await;
    let title = tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            let event = events.recv().await.unwrap();
            if event["type"] == "title" {
                break event;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(title["title"], "Fix browser titles ไทย");
    assert_eq!(title["titleEpoch"], initial["titleEpoch"]);
    h.host.running().await;
    assert!(
        h.events.lock().unwrap().contains(&title),
        "desktop and browsers receive the same title event"
    );
    let manual = h
        .host
        .command(
            "rename-title",
            Some(&json!({"id":card.id,"mode":"manual","title":"My task"})),
        )
        .await
        .unwrap();
    let board = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let event = events.recv().await.unwrap();
            if event["type"] == "remote-workspace" && event["workspace"]["cards"][0]["titleMode"] == "manual" {
                break event;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(board["workspace"]["cards"][0], json!(manual["card"]));
    assert_eq!(board["titleEpoch"], initial["titleEpoch"]);
    let (snapshot, _) = h.host.remote_attach().await;
    assert_eq!(snapshot["workspace"]["cards"][0]["title"], "My task");
    h.host.command("close", None).await.unwrap();
}

#[tokio::test]
async fn remote_workspace_replacement_broadcasts_a_new_epoch_even_when_the_board_is_identical() {
    let h = Harness::new();
    h.host.command("initialize", None).await.unwrap();
    let (snapshot, mut events) = h.host.remote_attach().await;
    let replacement = h.host.command("new", None).await.unwrap();
    assert_eq!(snapshot["workspace"], replacement["workspace"]);
    assert_ne!(snapshot["titleEpoch"], replacement["titleEpoch"]);
    let event = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let event = events.recv().await.unwrap();
            if event["type"] == "remote-workspace" && event["titleEpoch"] == replacement["titleEpoch"] {
                break event;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(event["workspace"], replacement["workspace"]);
}

#[tokio::test]
async fn remote_attachment_preserves_desktop_state_sequences_and_event_delivery() {
    let h = Harness::new();
    h.host.command("initialize", None).await.unwrap();
    let card = h.start().await;
    let id = card["id"].as_str().unwrap().to_owned();
    h.host.input(&id, "desktop-first".into(), 0);
    let (snapshot, mut remote_events) = h.host.remote_attach().await;
    assert_eq!(snapshot["workspace"]["cards"][0]["id"], card["id"]);
    assert_eq!(snapshot["terminals"][0]["running"], true);
    assert_eq!(snapshot["terminals"][0]["cols"], 80);
    let active = Arc::new(std::sync::atomic::AtomicBool::new(true));
    h.host.remote_input(id.clone(), "remote".into(), active).await.unwrap();
    h.host.remote_attach().await;
    h.host.input(&id, "desktop-second".into(), 1);
    h.host.running().await;
    let (key, events, process) = h.launches.lock().unwrap()[0].clone();
    assert_eq!(
        process.lock().unwrap().writes,
        ["desktop-first", "remote", "desktop-second"]
    );
    events(key, SessionEvent::Output("shared-output".into()));
    h.host.running().await;
    assert!(
        h.events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event["data"] == "shared-output")
    );
    let received = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let event = remote_events.recv().await.unwrap();
            if event["type"] == "data" {
                break event;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(received["data"], "shared-output");
    let (snapshot, _) = h.host.remote_attach().await;
    assert_eq!(snapshot["output"][&id], "shared-output");
    h.host.resize(&id, &json!(92), &json!(31));
    let (snapshot, _) = h.host.remote_attach().await;
    assert_eq!(snapshot["terminals"][0]["cols"], 92);
    assert_eq!(snapshot["terminals"][0]["rows"], 31);
    h.host.remote_detach().await;
    h.host.input(&id, "desktop-after-stop".into(), 2);
    h.host.running().await;
    assert_eq!(process.lock().unwrap().writes.last().unwrap(), "desktop-after-stop");
}

#[tokio::test]
async fn remote_input_rechecks_revocation_and_uses_the_existing_utf16_limit() {
    let h = Harness::new();
    let card = h.start().await;
    let id = card["id"].as_str().unwrap().to_owned();
    let revoked = Arc::new(std::sync::atomic::AtomicBool::new(false));
    assert_eq!(
        h.host
            .remote_input(id.clone(), "unsafe".into(), revoked)
            .await
            .unwrap_err(),
        "Session revoked."
    );
    let active = Arc::new(std::sync::atomic::AtomicBool::new(true));
    assert_eq!(
        h.host.remote_input(id, "🚀".repeat(32769), active).await.unwrap_err(),
        "Input exceeds 64 KB."
    );
    assert!(h.launches.lock().unwrap()[0].2.lock().unwrap().writes.is_empty());
}

#[tokio::test]
async fn clipboard_limits_count_utf16_and_os_failures_reach_the_renderer() {
    let h = Harness::new();
    *h.platform.clipboard.lock().unwrap() = "first\nsecond".into();
    assert_eq!(
        h.host.command("clipboard-read", None).await.unwrap(),
        json!({"text":"first\nsecond"})
    );
    // Copy and paste share one limit, so the largest selection the app copies can be pasted back.
    *h.platform.clipboard.lock().unwrap() = "😀".repeat(524288);
    assert_eq!(
        h.host.command("clipboard-read", None).await.unwrap()["text"],
        "😀".repeat(524288)
    );
    h.platform.clipboard.lock().unwrap().push('x');
    assert_eq!(
        h.host.command("clipboard-read", None).await.unwrap_err(),
        "Paste exceeds 1 MB."
    );
    for text in [Value::Null, json!(123), json!("😀".repeat(524289))] {
        assert_eq!(
            h.host.command("clipboard-write", Some(&text)).await.unwrap_err(),
            "Selection exceeds 1 MB."
        );
    }
    assert_eq!(h.platform.writes.load(Ordering::SeqCst), 0);
    assert!(
        h.host
            .command("clipboard-write", Some(&json!("😀".repeat(524288))))
            .await
            .is_ok()
    );
    *h.platform.read_failure.lock().unwrap() = Some("Read failed".into());
    *h.platform.write_failure.lock().unwrap() = Some("Write failed".into());
    assert_eq!(h.host.command("clipboard-read", None).await.unwrap_err(), "Read failed");
    assert_eq!(
        h.host
            .command("clipboard-write", Some(&json!("text")))
            .await
            .unwrap_err(),
        "Write failed"
    );
}

#[tokio::test]
async fn clipboard_write_does_not_acknowledge_an_os_operation_that_is_still_pending() {
    let h = Harness::new();
    let (finish, gate) = tokio::sync::oneshot::channel();
    *h.platform.write_gate.lock().unwrap() = Some(gate);
    let host = Arc::clone(&h.host);
    let task = tokio::spawn(async move { host.command("clipboard-write", Some(&json!("selected"))).await });
    while h.platform.write_gate.lock().unwrap().is_some() {
        tokio::task::yield_now().await;
    }
    assert!(!task.is_finished());
    finish.send(()).unwrap();
    assert_eq!(task.await.unwrap().unwrap(), json!({"ok":true}));
}

#[tokio::test]
async fn links_are_normalized_and_unsafe_links_never_reach_the_os() {
    let h = Harness::new();
    for (link, normalized) in [
        ("HTTPS://GITHUB.COM/a%20b", "https://github.com/a%20b"),
        ("http://localhost:4174", "http://localhost:4174/"),
    ] {
        h.host.command("open-link", Some(&json!(link))).await.unwrap();
        assert_eq!(h.platform.links.lock().unwrap().last().unwrap(), normalized);
    }
    for value in [
        Value::Null,
        json!({}),
        json!(42),
        json!(""),
        json!("/relative"),
        json!("//github.com"),
        json!("javascript:alert(1)"),
        json!("data:text/html,hi"),
        json!("file:///etc/passwd"),
        json!("mailto:a@b.com"),
        json!("https:"),
        json!("https://"),
        json!("https:github.com"),
        json!("http://[invalid]"),
        json!("https://github.com:99999"),
        json!("https://user:password@github.com"),
        json!("https://user@github.com"),
        json!(" https://github.com"),
        json!("https://github.com/a b"),
        json!("https://git\nhub.com"),
        json!("https://github.com/\0"),
    ] {
        assert!(h.host.command("open-link", Some(&value)).await.is_err(), "{value}");
    }
    assert_eq!(h.platform.links.lock().unwrap().len(), 2);
    *h.platform.link_failure.lock().unwrap() = Some("No default browser available.".into());
    assert_eq!(
        h.host
            .command("open-link", Some(&json!("https://github.com")))
            .await
            .unwrap_err(),
        "No default browser available."
    );
}

#[tokio::test]
async fn startup_reports_a_missing_hook_so_users_know_why_nothing_can_open_terminals() {
    let h = Harness::with_hook(true);
    let initial = h.host.command("initialize", None).await.unwrap();
    assert!(initial.get("warning").is_none(), "{initial}");

    let h = Harness::new();
    let initial = h.host.command("initialize", None).await.unwrap();
    assert_eq!(initial["warning"], HELPER_MISSING);
    // A workspace that cannot be restored is reported first, on its own line.
    std::fs::write(h.recovery(), b"{").unwrap();
    let initial = h.host.command("initialize", None).await.unwrap();
    let warning = initial["warning"].as_str().unwrap();
    let lines: Vec<_> = warning.lines().collect();
    assert_eq!(lines.len(), 2, "{warning}");
    assert!(
        lines[0].starts_with("Could not restore your last workspace: "),
        "{warning}"
    );
    assert_eq!(lines[1], HELPER_MISSING);
}

#[tokio::test]
async fn close_flushes_host_metadata_over_stale_layout_and_reopens_stopped() {
    let h = Harness::new();
    h.host.command("initialize", None).await.unwrap();
    let card = h.start().await;
    let mut board = json!(create_workspace());
    board["cards"] = json!([card]);
    h.host.command("autosave", Some(&board)).await.unwrap();
    h.report_session().await;
    assert!(h.host.close_requested());
    assert!(h.host.exit_requested());
    h.host.running().await;
    assert_eq!(
        h.host.running().await,
        1,
        "asking to close must not stop the shell before confirmation"
    );
    assert_eq!(
        h.events.lock().unwrap().last().unwrap(),
        &json!({"type":"closing", "running":1})
    );
    board["name"] = json!("Last change before debounce");
    h.host.command("close", Some(&board)).await.unwrap();
    assert!(h.launches.lock().unwrap()[0].2.lock().unwrap().killed);
    assert_eq!(h.platform.closed.load(Ordering::SeqCst), 1);
    let saved = h.read_saved();
    assert_eq!(saved["name"], board["name"]);
    assert_eq!(
        saved["cards"][0]["session"]["sessionId"],
        "12345678-1234-4321-9876-123456789abc"
    );
    let restored = h.host.command("initialize", None).await.unwrap();
    assert_eq!(restored["workspace"], saved);
    assert_eq!(h.host.running().await, 0);
    assert_eq!(h.launches.lock().unwrap().len(), 1);
    assert!(!h.host.exit_requested());
}

#[tokio::test]
async fn claude_accounts_are_listed_added_and_kept_by_the_cards_that_use_them() {
    let h = Harness::new();
    h.host.command("initialize", None).await.unwrap();
    let list = |create: Option<&str>| {
        let payload = create.map_or_else(|| json!({}), |name| json!({ "create": name }));
        let host = h.host.clone();
        async move { host.command("claude-accounts", Some(&payload)).await }
    };
    assert_eq!(list(None).await.unwrap(), json!({ "accounts": [], "signedIn": {} }));
    assert_eq!(
        list(Some(" Work ")).await.unwrap(),
        json!({ "accounts": ["Work"], "signedIn": {}, "created": "Work" })
    );
    assert_eq!(
        list(Some("work")).await.unwrap(),
        json!({ "accounts": ["Work"], "signedIn": {}, "created": "Work" }),
        "names differing only in case are one account"
    );
    assert_eq!(
        list(Some("../escape")).await.unwrap_err(),
        "Account names use 1 to 40 letters, digits, spaces, hyphens, or underscores."
    );
    let accounts = h.folder.join("claude-accounts");
    assert!(!h.folder.join("escape").exists());
    // A card whose account folder is gone recreates it when it starts, and keeps the account.
    let mut card = json!(create_card(&json!({ "cwd": h.folder })).unwrap());
    card["claudeAccount"] = json!("Personal");
    h.host
        .command("start", Some(&json!({ "card": card, "cols": 80, "rows": 24 })))
        .await
        .unwrap();
    assert!(accounts.join("Personal").is_dir());
    let mut board = json!(create_workspace());
    board["cards"] = json!([card]);
    h.host.command("autosave", Some(&board)).await.unwrap();
    assert_eq!(h.read_saved()["cards"][0]["claudeAccount"], "Personal");
    // An account reports the email Claude Code recorded when it signed in.
    std::fs::write(
        accounts.join("Work").join(".claude.json"),
        r#"{"oauthAccount":{"emailAddress":"work@example.com"}}"#,
    )
    .unwrap();
    assert_eq!(
        list(None).await.unwrap(),
        json!({ "accounts": ["Personal", "Work"], "signedIn": { "Work": "work@example.com" } })
    );
}

#[tokio::test]
async fn more_than_24_terminals_start_save_and_restore_stopped() {
    let h = Harness::new();
    h.host.command("initialize", None).await.unwrap();
    let mut board = json!(create_workspace());
    for _ in 0..32 {
        let card = h.start().await;
        board["cards"].as_array_mut().unwrap().push(card);
    }
    assert_eq!(h.host.running().await, 32);
    h.host.command("autosave", Some(&board)).await.unwrap();
    assert_eq!(h.read_saved(), board);
    h.host.command("close", Some(&board)).await.unwrap();
    assert_eq!(h.host.running().await, 0);
    assert!(
        h.launches
            .lock()
            .unwrap()
            .iter()
            .all(|(_, _, process)| process.lock().unwrap().killed)
    );
    let restored = h.host.command("initialize", None).await.unwrap();
    assert_eq!(restored["workspace"], board);
    assert_eq!(h.launches.lock().unwrap().len(), 32, "restoring never starts processes");
}

#[tokio::test]
async fn renderer_crashes_preserve_the_last_host_known_workspace() {
    let h = Harness::new();
    h.host.command("initialize", None).await.unwrap();
    h.start().await;
    h.report_session().await;
    h.host.renderer_crashed().await;
    assert!(h.launches.lock().unwrap()[0].2.lock().unwrap().killed);
    assert_eq!(h.read_saved()["cards"][0]["session"]["provider"], "claude");
    assert!(h.host.quitting());
    assert_eq!(h.platform.closed.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn input_reorders_a_large_paste_and_typing_without_repeating_duplicates() {
    let h = Harness::new();
    let card = h.start().await;
    let id = card["id"].as_str().unwrap();
    h.host.input(id, "typed".into(), 1);
    h.host.input(id, "duplicate".into(), 1);
    h.host.running().await;
    assert!(h.launches.lock().unwrap()[0].2.lock().unwrap().writes.is_empty());
    let paste = "p".repeat(64000);
    h.host.input(id, paste.clone(), 0);
    h.host.input(id, "stale".into(), 0);
    h.host.running().await;
    assert_eq!(
        h.launches.lock().unwrap()[0].2.lock().unwrap().writes,
        [paste, "typed".into()]
    );
    h.host.input(id, "x".repeat(65537), 2);
    h.host.input(id, "after error".into(), 3);
    h.host.running().await;
    assert_eq!(
        h.events.lock().unwrap().last().unwrap()["message"],
        "Input exceeds 64 KB."
    );
    assert_eq!(
        h.launches.lock().unwrap()[0].2.lock().unwrap().writes.last().unwrap(),
        "after error"
    );
    // The bridge splits a paste longer than one message; the pieces can arrive in any order.
    let pieces = ["a".repeat(65536), "b".repeat(65536), "c".repeat(100)];
    h.host.input(id, "typed after".into(), 7);
    h.host.input(id, pieces[2].clone(), 6);
    h.host.input(id, pieces[0].clone(), 4);
    h.host.input(id, pieces[1].clone(), 5);
    h.host.running().await;
    assert_eq!(
        h.launches.lock().unwrap()[0].2.lock().unwrap().writes[3..],
        [
            pieces[0].clone(),
            pieces[1].clone(),
            pieces[2].clone(),
            "typed after".into()
        ]
    );
    h.host.command("close", None).await.unwrap();
}

#[tokio::test]
async fn metadata_is_saved_without_waiting_for_a_renderer_autosave() {
    let h = Harness::new();
    h.start().await;
    h.report_session().await;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        if h.read_saved()["cards"][0]["session"]["sessionId"] == "12345678-1234-4321-9876-123456789abc" {
            break;
        }
        assert!(std::time::Instant::now() < deadline);
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    h.host.command("close", None).await.unwrap();
}

#[tokio::test]
async fn failed_recovery_write_stops_the_terminal_and_does_not_close_the_window() {
    let h = Harness::new();
    std::fs::create_dir_all(h.recovery()).unwrap();
    let card = json!(create_card(&json!({"cwd":h.folder})).unwrap());
    assert!(
        h.host
            .command("start", Some(&json!({"card":card,"cols":80,"rows":24})))
            .await
            .is_err()
    );
    assert_eq!(h.host.running().await, 0);
    assert!(h.launches.lock().unwrap()[0].2.lock().unwrap().killed);
    assert!(h.host.command("close", None).await.is_err());
    assert_eq!(h.platform.closed.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn new_workspace_discards_late_events_from_old_processes() {
    let h = Harness::new();
    h.start().await;
    h.host.command("new", None).await.unwrap();
    h.report_session().await;
    h.host.command("autosave", None).await.unwrap();
    assert_eq!(h.read_saved()["cards"], json!([]));
    assert_eq!(h.host.running().await, 0);
}

#[tokio::test]
async fn canceled_dialogs_leave_state_intact_and_folder_picker_uses_valid_defaults() {
    let h = Harness::new();
    let board = json!(create_workspace());
    for action in ["save", "save-as", "export", "open", "pick-image"] {
        assert_eq!(
            h.host.command(action, Some(&board)).await.unwrap(),
            json!({"canceled":true})
        );
    }
    assert_eq!(
        h.host
            .command("pick-folder", Some(&json!({"cwd":"/not-a-real-tc-folder"})))
            .await
            .unwrap(),
        json!({"path":null})
    );
    assert_eq!(h.platform.defaults.lock().unwrap()[0], Some(h.folder.clone()));
    assert_eq!(h.host.running().await, 0);
}

#[tokio::test]
async fn save_remembers_its_filename_while_export_keeps_it_and_roundtrips_images() {
    let h = Harness::new();
    let bytes = b"\x89PNG\r\n\x1a\n-image".to_vec();
    let asset = h.host.import_image(Some(bytes.clone())).await.unwrap()["asset"].clone();
    let mut board = json!(create_workspace());
    board["name"] = json!("Board 😀");
    board["items"] = json!([{"id":"image-1", "type":"image", "x":0, "y":0, "w":100, "h":100, "asset":asset}]);
    let saved = h.folder.join("saved.terminalcanvas");
    h.platform.chosen.lock().unwrap().push_back(Some(saved.clone()));
    h.host.command("save", Some(&board)).await.unwrap();
    assert_eq!(h.platform.save_names.lock().unwrap()[0], "Board .terminalcanvas");
    let exported = h.folder.join("portable.terminalcanvas");
    h.platform.chosen.lock().unwrap().push_back(Some(exported.clone()));
    assert_eq!(
        h.host.command("export", Some(&board)).await.unwrap(),
        json!({"ok":true,"images":1,"missing":0})
    );
    let portable: Value = serde_json::from_slice(&std::fs::read(&exported).unwrap()).unwrap();
    assert_eq!(portable["version"], 3);
    assert!(portable["assets"][asset.as_str().unwrap()].is_string());
    board["name"] = json!("Changed");
    h.host.command("save", Some(&board)).await.unwrap();
    let ordinary: Value = serde_json::from_slice(&std::fs::read(saved).unwrap()).unwrap();
    assert_eq!(ordinary["name"], "Changed");
    assert!(ordinary.get("assets").is_none());
    std::fs::remove_file(h.folder.join("assets").join(asset.as_str().unwrap())).unwrap();
    h.platform.chosen.lock().unwrap().push_back(Some(exported));
    assert_eq!(
        h.host.command("open", None).await.unwrap()["workspace"]["items"][0]["asset"],
        asset
    );
    assert_eq!(
        std::fs::read(h.folder.join("assets").join(asset.as_str().unwrap())).unwrap(),
        bytes
    );
    assert_eq!(h.host.running().await, 0);
    h.host.command("autosave", None).await.unwrap();
}

#[tokio::test]
async fn image_cleanup_recomputes_keep_lists_and_rejects_json_image_data() {
    let h = Harness::new();
    assert_eq!(h.host.import_image(None).await.unwrap_err(), "Invalid image data.");
    let asset = h
        .host
        .import_image(Some(b"\x89PNG\r\n\x1a\n-image".to_vec()))
        .await
        .unwrap()["asset"]
        .clone();
    assert_eq!(
        h.host
            .command("unused-images", Some(&json!({"keep":[]})))
            .await
            .unwrap()["count"],
        1
    );
    assert_eq!(
        h.host
            .command("delete-unused-images", Some(&json!({"keep":[asset]})))
            .await
            .unwrap()["deleted"],
        0
    );
    assert_eq!(
        h.host
            .command("delete-unused-images", Some(&json!({"keep":[]})))
            .await
            .unwrap()["deleted"],
        1
    );
}

#[tokio::test]
async fn legacy_autosave_and_portable_images_open_stopped_and_rust_files_are_readable_by_the_legacy_host() {
    use base64::Engine;
    use std::process::Command;
    use tc_core::workspace::validate_workspace;

    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let fixture: Value =
        serde_json::from_slice(&std::fs::read(root.join("tests/golden/host-workspace.json")).unwrap()).unwrap();
    let expected = validate_workspace(&fixture["autosave"]).unwrap();
    // During transition the reference is still in src; after cutover only the frozen test oracle remains.
    let archived = root.join("tests/reference/node-host");
    let reference = if archived.is_dir() { archived } else { root.join("src") };
    let node_reader = r#"
        const fs = require('node:fs');
        const { validateWorkspace } = require(process.argv[1]);
        const assets = require(process.argv[2]);
        (async () => {
            const raw = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
            const extracted = await assets.extractAssets(raw, process.argv[4]);
            const board = validateWorkspace(extracted);
            const embedded = await assets.embedAssets(board, process.argv[4]);
            process.stdout.write(JSON.stringify({ board, ...embedded }));
        })().catch(error => { console.error(error); process.exit(1); });
    "#;
    for input in ["autosave", "portable"] {
        let h = Harness::new();
        std::fs::write(h.recovery(), serde_json::to_vec(&fixture[input]).unwrap()).unwrap();
        if input == "autosave" {
            let assets = h.folder.join("assets");
            std::fs::create_dir_all(&assets).unwrap();
            for (name, bytes) in fixture["imageFiles"].as_object().unwrap() {
                std::fs::write(
                    assets.join(name),
                    base64::engine::general_purpose::STANDARD
                        .decode(bytes.as_str().unwrap())
                        .unwrap(),
                )
                .unwrap();
            }
        }
        let restored = h.host.command("initialize", None).await.unwrap();
        assert_eq!(
            restored["warning"], HELPER_MISSING,
            "{input}: only the harness's missing hook is reported: {restored}"
        );
        assert_eq!(validate_workspace(&restored["workspace"]).unwrap(), expected);
        assert_eq!(h.host.running().await, 0);
        assert!(
            h.launches.lock().unwrap().is_empty(),
            "opening legacy cards must not execute their commands"
        );
        for (name, bytes) in fixture["imageFiles"].as_object().unwrap() {
            let response = terminal_canvas::protocol::asset_response(
                &h.folder.join("assets"),
                &format!("tc-asset://images/{name}"),
            );
            assert_eq!(response.status(), 200);
            assert_eq!(
                response.body(),
                &base64::engine::general_purpose::STANDARD
                    .decode(bytes.as_str().unwrap())
                    .unwrap()
            );
        }
        h.host.command("autosave", Some(&restored["workspace"])).await.unwrap();
        let exported = h.folder.join("rust-portable.terminalcanvas");
        h.platform.chosen.lock().unwrap().push_back(Some(exported.clone()));
        assert_eq!(
            h.host.command("export", Some(&restored["workspace"])).await.unwrap()["missing"],
            0
        );
        for file in [h.recovery(), exported] {
            let asset_folder = if file == h.recovery() {
                h.folder.join("assets")
            } else {
                h.folder.join("legacy-extracted")
            };
            let output = Command::new("node")
                .arg("-e")
                .arg(node_reader)
                .arg(reference.join("workspace.cjs"))
                .arg(reference.join("assets.cjs"))
                .arg(&file)
                .arg(&asset_folder)
                .output()
                .expect("node is needed for legacy compatibility checks");
            assert!(
                output.status.success(),
                "{}: {}",
                file.display(),
                String::from_utf8_lossy(&output.stderr)
            );
            let legacy: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(validate_workspace(&legacy["board"]).unwrap(), expected);
            assert_eq!(legacy["assets"], fixture["portable"]["assets"]);
            assert_eq!(legacy["missing"], json!([]));
        }
    }
}

#[tokio::test]
async fn programs_outside_the_canvas_open_terminals_and_hear_back_through_the_app_inbox() {
    use tc_core::launch::{app_inbox, log_path, result_path, validate_request, write_request};
    let h = Harness::new();
    let inbox = app_inbox(&h.folder);
    assert!(inbox.is_dir(), "the app creates its inbox at startup");
    let platform = tc_core::Platform::current();
    let raw = json!({ "profile": "codex", "title": "Reviewer", "cwd": h.folder, "parent": "parent-card",
        "reply": true, "log": true });
    let (id, _) = write_request(&inbox, &validate_request(&raw, platform).unwrap()).unwrap();
    let mut missing = validate_request(&json!({ "cwd": h.folder, "reply": true }), platform).unwrap();
    missing.cwd = h.folder.join("gone").to_string_lossy().into_owned();
    let (refused, _) = write_request(&inbox, &missing).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let seen = |kind: &str| {
        h.events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e["type"] == kind)
            .cloned()
            .collect::<Vec<_>>()
    };
    while (seen("launch").is_empty() || seen("error").is_empty()) && std::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(
        seen("launch"),
        [
            json!({ "type": "launch", "external": true, "request": id, "profile": "codex", "title": "Reviewer",
            "cwd": h.folder.to_string_lossy(), "command": "codex", "parent": "parent-card" })
        ]
    );
    assert_eq!(
        seen("error")[0]["message"],
        "Could not open the requested terminal: Working directory is unavailable."
    );
    let refusal: Value = serde_json::from_slice(&std::fs::read(result_path(&inbox, &refused)).unwrap()).unwrap();
    assert_eq!(refusal["status"], "refused");

    // The UI starts the card with the request ID, so its output is logged from the first byte.
    let card = json!(create_card(&json!({ "cwd": h.folder, "profile": "codex" })).unwrap());
    h.host
        .command(
            "start",
            Some(&json!({ "card": card, "cols": 80, "rows": 24, "launch": id })),
        )
        .await
        .unwrap();
    let (key, events, _) = h.launches.lock().unwrap()[0].clone();
    events(key.clone(), SessionEvent::Output("\x1b[1mworking\x1b[0m\r\n".into()));
    let card_id = card["id"].as_str().unwrap();
    assert_eq!(
        h.host
            .command(
                "launch-result",
                Some(&json!({ "request": id, "card": card_id, "parent": "parent-card" }))
            )
            .await
            .unwrap(),
        json!({ "ok": true })
    );
    let log = log_path(&inbox, &id);
    let answer: Value = serde_json::from_slice(&std::fs::read(result_path(&inbox, &id)).unwrap()).unwrap();
    assert_eq!(
        answer,
        json!({ "status": "opened", "card": card_id, "parent": "parent-card", "log": log.to_string_lossy(),
            "warning": NO_INTEGRATION }),
        "this harness has no tc-hook, so the requester learns the new terminal has no integration"
    );
    events(key, SessionEvent::Exit(ExitStatus { code: 0, signal: None }));
    h.host.running().await;
    let mut text = String::new();
    for _ in 0..100 {
        text = std::fs::read_to_string(&log).unwrap_or_default();
        if text.contains("exited") {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(text, "working\n\n[Terminal Canvas: the process exited with code 0]\n");
    assert_eq!(
        h.host
            .command("launch-result", Some(&json!({ "request": id, "card": card_id })))
            .await
            .unwrap(),
        json!({ "ok": false }),
        "a request is answered once"
    );
    assert!(
        h.host
            .command("launch-result", Some(&json!({ "request": "../x", "card": "c" })))
            .await
            .is_err()
    );
}

const POINTER_TOKEN: &str = "abcdef01-1234-4321-9876-123456789abc";
const POINTER_SESSION: &str = "12345678-1234-4321-9876-123456789abc";

impl Harness {
    async fn pointer_output(&self, index: usize, data: String) {
        let (key, events, _) = self.launches.lock().unwrap()[index].clone();
        events(key, SessionEvent::Output(data));
        self.host.running().await;
    }
    async fn pointer_agent(&self, index: usize) {
        use base64::Engine;
        let report = json!({"type":"launch", "provider":"claude", "token":POINTER_TOKEN, "sessionId":POINTER_SESSION,"cwd":self.folder});
        self.pointer_output(
            index,
            format!(
                "\x1b]633;TC;{}\x07",
                base64::engine::general_purpose::STANDARD.encode(report.to_string())
            ),
        )
        .await;
    }
    async fn pointer_request(&self, index: usize, kind: &str) -> Value {
        self.pointer_custom_request(index, kind, POINTER_TOKEN).await
    }
    async fn pointer_custom_request(&self, index: usize, kind: &str, token: &str) -> Value {
        let (_, _, process) = self.launches.lock().unwrap()[index].clone();
        let inbox = PathBuf::from(&process.lock().unwrap().env["TC_LAUNCH_DIR"]);
        let report = tc_core::pointers::Report {
            kind: kind.into(),
            provider: "claude".into(),
            token: token.into(),
            session_id: POINTER_SESSION.into(),
            message: "Finished safely".into(),
            name: "done".into(),
            exit_code: None,
            stop_hook_active: false,
            expires: tc_core::pointers::now_ms() + 3000,
        };
        let (id, _) = tc_core::pointers::write_request(&inbox, &report).unwrap();
        let path = tc_core::pointers::answer_path(&inbox, &id);
        for _ in 0..160 {
            if let Ok(bytes) = std::fs::read(&path) {
                return serde_json::from_slice(&bytes).unwrap();
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("No answer for {kind}");
    }
    async fn pointer_config(&self, source: &Value, target: &Value, id: &str, action: &str, event: &str) {
        let mut board = self.read_saved();
        board["items"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":id,"type":"line","start":{"id":source["id"]},"end":{"id":target["id"]},"arrow":true}));
        self.host.command("pointer-configure", Some(&json!({"workspace":board,"id":id,"hook":{"event":event,"action":action,"text":"echo delivered","armed":true}}))).await.unwrap();
    }
    fn pointer_writes(&self, index: usize) -> Vec<String> {
        self.launches.lock().unwrap()[index].2.lock().unwrap().writes.clone()
    }
}

#[tokio::test]
async fn pointer_setup_checks_readiness_without_saving_or_sending_input() {
    let h = Harness::with_hook(true);
    let source = h.start().await;
    let target = h.start().await;
    let mut check = json!({"source":source["id"], "target":target["id"], "event":"trigger", "action":"shell"});
    let saved = h.read_saved();
    let before = (h.pointer_writes(0), h.pointer_writes(1));
    let status = h.host.command("pointer-check", Some(&check)).await.unwrap();
    assert_eq!(status["source"], "The terminal can accept manual triggers.");
    assert_eq!(
        status["target"],
        "Wait for an idle prompt in an integrated PowerShell or Bash shell."
    );
    h.pointer_output(1, "\x1b]777;tc-ready;1\x07".into()).await;
    let status = h.host.command("pointer-check", Some(&check)).await.unwrap();
    assert_eq!(status["target"], "The shell is idle and can run a command.");
    check["event"] = json!("stop");
    let status = h.host.command("pointer-check", Some(&check)).await.unwrap();
    assert!(status["source"].as_str().unwrap().contains("/hooks"));
    assert_eq!((h.pointer_writes(0), h.pointer_writes(1)), before);
    assert_eq!(h.read_saved(), saved);
    check["target"] = json!("missing");
    assert!(h.host.command("pointer-check", Some(&check)).await.is_err());
}

#[tokio::test]
async fn pointer_launches_the_selected_ai_in_only_the_idle_target() {
    use tc_core::pointers::PromptLaunch;

    let h = Harness::with_hook(true);
    let source = h.start().await;
    let target = h.start().await;
    let id = target["id"].as_str().unwrap();
    let mut board = h.read_saved();
    board["items"] = json!([{"id":"review","type":"line","start":{"id":source["id"]},"end":{"id":id},"arrow":true}]);
    let prompt = "--review\nUse \"quotes\", $variables and & as text.";
    let rule = json!({"workspace":board,"id":"review","hook":{
        "event":"trigger", "action":"prompt", "armed":true, "provider":"claude", "model":"sonnet[1m]", "text":prompt
    }});
    h.host.command("pointer-configure", Some(&rule)).await.unwrap();
    let check = json!({"source":source["id"], "target":id, "event":"trigger", "action":"prompt", "provider":"claude"});
    let before = h.pointer_writes(1).len();
    let status = h.host.command("pointer-check", Some(&check)).await.unwrap();
    assert!(status["target"].as_str().unwrap().contains("Leave an integrated"));
    assert_eq!(h.pointer_writes(1).len(), before);

    h.pointer_output(1, "\x1b]777;tc-ready;1\x07".into()).await;
    let status = h.host.command("pointer-check", Some(&check)).await.unwrap();
    assert!(status["target"].as_str().unwrap().contains("can start the selected"));
    assert_eq!(h.pointer_request(0, "trigger").await["failed"], 0);
    let writes = h.pointer_writes(1);
    assert_eq!(writes.len(), before + 1);
    let request = writes
        .last()
        .unwrap()
        .trim_end()
        .split_once(" launch-prompt ")
        .unwrap()
        .1;
    assert!(tc_core::launch::is_request_id(request));
    let (_, _, process) = h.launches.lock().unwrap()[1].clone();
    let inbox = PathBuf::from(&process.lock().unwrap().env["TC_LAUNCH_DIR"]);
    let launch = PromptLaunch::take(&inbox, request).unwrap();
    assert_eq!(launch.provider, tc_core::session::Provider::Claude);
    assert_eq!(launch.model.as_deref(), Some("sonnet[1m]"));
    assert_eq!(launch.text, prompt);
    assert!(PromptLaunch::take(&inbox, request).is_err());

    tokio::time::sleep(std::time::Duration::from_millis(1010)).await;
    h.pointer_output(1, "\x1b]777;tc-ready;1\x07".into()).await;
    h.host.input(id, "my draft".into(), 0);
    h.host.running().await;
    let before = h.pointer_writes(1).len();
    assert_eq!(h.pointer_request(0, "trigger").await["failed"], 1);
    assert_eq!(h.pointer_writes(1).len(), before);
}

#[tokio::test]
async fn pointers_deliver_to_ready_shells_and_never_submit_partial_user_input() {
    let h = Harness::with_hook(true);
    let source = h.start().await;
    let target = h.start().await;
    h.pointer_config(&source, &target, "first", "shell", "trigger").await;
    h.pointer_output(1, "\x1b]777;tc-ready;1\x07".into()).await;
    h.pointer_request(0, "trigger").await;
    assert!(h.pointer_writes(1).contains(&"echo delivered\r".into()));
    h.pointer_output(1, "\x1b]777;tc-ready;1\x07".into()).await;
    h.pointer_config(&source, &target, "typing", "shell", "trigger").await;
    h.host.input(target["id"].as_str().unwrap(), "unfinished".into(), 0);
    h.host.running().await;
    let before = h.pointer_writes(1).len();
    h.pointer_request(0, "trigger").await;
    assert_eq!(h.pointer_writes(1).len(), before);
    assert!(
        h.events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e["id"] == "typing" && e["message"].as_str().unwrap_or_default().contains("user input"))
    );
}

#[tokio::test]
async fn hidden_canvas_pointers_run_in_the_actor_and_remote_typing_blocks_delivery() {
    let h = Harness::with_hook(true);
    let source = h.start().await;
    let target = h.start().await;
    let foreground = h.start().await;
    let mut board = h.read_saved();
    board["canvases"] = json!([
        {"id":"foreground", "name":"Foreground", "camera":board["camera"], "cardIds":[foreground["id"]], "itemIds":[]},
        {"id":"background", "name":"Background", "camera":board["camera"], "cardIds":[source["id"],target["id"]], "itemIds":["hidden"]}
    ]);
    board["activeCanvas"] = json!("foreground");
    board["items"] =
        json!([{"id":"hidden","type":"line","arrow":true,"start":{"id":source["id"]},"end":{"id":target["id"]}}]);
    h.host.command("pointer-configure", Some(&json!({"workspace":board,"id":"hidden","hook":{"event":"trigger","action":"shell","text":"echo hidden","armed":true}}))).await.unwrap();
    h.pointer_output(1, "\x1b]777;tc-ready;1\x07".into()).await;
    let target_id = target["id"].as_str().unwrap();
    h.host.input(target_id, "\x1b[I".into(), 0);
    h.host.input(target_id, "\x1b[O".into(), 1);
    h.host.running().await;
    assert!(h.pointer_writes(1).contains(&"\x1b[I".into()));
    assert!(h.pointer_writes(1).contains(&"\x1b[O".into()));
    h.pointer_request(0, "trigger").await;
    assert!(h.pointer_writes(1).contains(&"echo hidden\r".into()));
    assert_eq!(h.read_saved()["activeCanvas"], "foreground");

    h.pointer_output(1, "\x1b]777;tc-ready;1\x07".into()).await;
    let mut board = h.read_saved();
    board["items"][0]["id"] = json!("remote-typing");
    board["canvases"][1]["itemIds"] = json!(["remote-typing"]);
    h.host.command("pointer-configure", Some(&json!({"workspace":board,"id":"remote-typing","hook":{"event":"trigger","action":"shell","text":"echo forbidden","armed":true}}))).await.unwrap();
    h.host.remote_attach().await;
    h.host
        .remote_input(
            target["id"].as_str().unwrap().into(),
            "unfinished".into(),
            Arc::new(std::sync::atomic::AtomicBool::new(true)),
        )
        .await
        .unwrap();
    let before = h.pointer_writes(1).len();
    h.pointer_request(0, "trigger").await;
    assert_eq!(h.pointer_writes(1).len(), before);
    assert!(
        h.events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event["id"] == "remote-typing"
                && event["state"] == "failed"
                && event["message"].as_str().unwrap_or_default().contains("user input"))
    );
    h.host
        .command("stop", Some(&json!({"id":target["id"],"removePointers":true})))
        .await
        .unwrap();
    let saved = h.read_saved();
    assert!(saved["items"].as_array().unwrap().is_empty());
    assert!(saved["canvases"][1]["itemIds"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn pointers_queue_busy_ai_prompts_and_chain_stop_to_a_shell_without_typing_into_busy_agents() {
    let h = Harness::with_hook(true);
    let source = h.start().await;
    let target = h.start().await;
    let shell = h.start().await;
    h.pointer_agent(0).await;
    h.pointer_agent(1).await;
    h.pointer_request(1, "busy").await;
    h.pointer_output(2, "\x1b]777;tc-ready;1\x07".into()).await;
    h.pointer_config(&source, &target, "planner", "prompt", "stop").await;
    h.pointer_config(&target, &shell, "tests", "shell", "stop").await;
    let before = h.pointer_writes(1).len();
    h.pointer_request(0, "stop").await;
    assert_eq!(h.pointer_writes(1).len(), before);
    assert!(
        h.events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e["id"] == "planner" && e["state"] == "queued")
    );
    assert_eq!(
        h.pointer_request(1, "stop").await,
        json!({"decision":"block","reason":"echo delivered"})
    );
    assert!(
        !h.pointer_writes(2).contains(&"echo delivered\r".into()),
        "outgoing work waits for the continuation to finish"
    );
    assert_eq!(h.pointer_request(1, "stop").await, json!({}));
    assert!(h.pointer_writes(2).contains(&"echo delivered\r".into()));
    assert_eq!(h.pointer_writes(1).len(), before);
}

#[tokio::test]
async fn pointers_disarm_cancels_queued_work_and_stale_layouts_cannot_rearm_it() {
    let h = Harness::with_hook(true);
    let source = h.start().await;
    let target = h.start().await;
    h.pointer_agent(1).await;
    h.pointer_request(1, "busy").await;
    h.pointer_config(&source, &target, "p", "prompt", "trigger").await;
    h.pointer_request(0, "trigger").await;
    let stale = h.read_saved();
    let mut hook = stale["items"][0]["hook"].clone();
    hook["armed"] = json!(false);
    h.host
        .command(
            "pointer-configure",
            Some(&json!({"workspace":stale,"id":"p","hook":hook})),
        )
        .await
        .unwrap();
    h.host.command("autosave", Some(&stale)).await.unwrap();
    assert_eq!(h.read_saved()["items"][0]["hook"]["armed"], false);
    assert_eq!(h.pointer_request(1, "stop").await, json!({}));
    h.host
        .command("pointer-configure", Some(&json!({"workspace":stale,"paused":true})))
        .await
        .unwrap();
    h.host.command("autosave", Some(&stale)).await.unwrap();
    assert_eq!(h.read_saved()["hooksPaused"], true);
}

#[tokio::test]
async fn pointers_fail_closed_unknown_and_stale_hooks_and_support_independent_fanout() {
    let h = Harness::with_hook(true);
    let source = h.start().await;
    let target = h.start().await;
    h.pointer_config(&source, &target, "unknown", "prompt", "trigger").await;
    let stopped = json!(create_card(&json!({"cwd":h.folder})).unwrap());
    let mut board = h.read_saved();
    board["cards"].as_array_mut().unwrap().push(stopped.clone());
    h.host.command("autosave", Some(&board)).await.unwrap();
    h.pointer_config(&source, &stopped, "closed", "shell", "trigger").await;
    h.pointer_request(0, "trigger").await;
    let events = h.events.lock().unwrap().clone();
    for id in ["unknown", "closed"] {
        assert!(events.iter().any(|e| e["id"] == id && e["state"] == "failed"));
    }
    h.pointer_agent(1).await;
    assert!(
        h.pointer_custom_request(1, "stop", "00000000-0000-4000-8000-000000000000")
            .await
            .get("error")
            .is_some()
    );
    h.pointer_request(1, "stop").await;
    h.pointer_config(&source, &target, "idle", "prompt", "trigger").await;
    h.pointer_request(0, "trigger").await;
    assert!(
        h.pointer_writes(1)
            .contains(&"\x1b[200~echo delivered\x1b[201~\r".into())
    );
}

#[tokio::test]
async fn new_terminal_pointer_actions_remain_subject_to_disarm_before_start() {
    let h = Harness::with_hook(true);
    let source = h.start().await;
    let template = h.start().await;
    h.pointer_config(&source, &template, "new", "new-terminal", "trigger")
        .await;
    h.pointer_request(0, "trigger").await;
    let launch = h
        .events
        .lock()
        .unwrap()
        .iter()
        .find(|e| e["type"] == "launch" && e["pointer"] == "new")
        .unwrap()
        .clone();
    assert_eq!(launch["command"], "echo delivered");
    assert_eq!(h.launches.lock().unwrap().len(), 2);
    h.host
        .command(
            "pointer-configure",
            Some(&json!({"workspace":h.read_saved(),"paused":true})),
        )
        .await
        .unwrap();
    let card = json!(create_card(&json!({"cwd":h.folder})).unwrap());
    let error = h
        .host
        .command(
            "start",
            Some(&json!({"card":card,"cols":80,"rows":24,"launch":launch["request"]})),
        )
        .await
        .unwrap_err();
    assert!(error.contains("disarmed"));
    assert_eq!(h.launches.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn closing_a_template_removes_host_pointers_before_a_stale_autosave_can_restore_them() {
    let h = Harness::with_hook(true);
    let source = h.start().await;
    let target = h.start().await;
    h.pointer_config(&source, &target, "p", "new-terminal", "trigger").await;
    let stale = h.read_saved();
    h.host
        .command("stop", Some(&json!({"id":target["id"],"removePointers":true})))
        .await
        .unwrap();
    assert!(h.read_saved()["items"].as_array().unwrap().is_empty());
    h.host.command("autosave", Some(&stale)).await.unwrap();
    assert!(h.read_saved()["items"][0].get("hook").is_none());
    h.pointer_request(0, "trigger").await;
    assert!(!h.events.lock().unwrap().iter().any(|e| e["type"] == "launch"));
}

#[tokio::test]
async fn a_failed_configuration_save_pauses_automation_instead_of_arming_it_invisibly() {
    let h = Harness::with_hook(true);
    let source = h.start().await;
    let target = h.start().await;
    let mut board = h.read_saved();
    board["items"] =
        json!([{"id":"p","type":"line","arrow":true,"start":{"id":source["id"]},"end":{"id":target["id"]}}]);
    std::fs::remove_file(h.recovery()).unwrap();
    std::fs::create_dir(h.recovery()).unwrap();
    let answer = h.host.command("pointer-configure", Some(&json!({"workspace":board,"id":"p","hook":{"event":"trigger","action":"new-terminal","text":"echo no","armed":true}}))).await;
    assert!(answer.is_err());
    assert!(h.events.lock().unwrap().iter().any(|e| e["type"] == "pointers-paused"));
    h.pointer_request(0, "trigger").await;
    assert!(!h.events.lock().unwrap().iter().any(|e| e["type"] == "launch"));
}

#[tokio::test]
async fn the_agent_setup_is_offered_once_and_installs_the_skill_where_agents_look() {
    let h = Harness::new();
    assert_eq!(
        h.host.command("initialize", None).await.unwrap().get("agentSetup"),
        None
    );
    assert_eq!(
        h.host.command("agent-setup", Some(&json!({}))).await.unwrap_err(),
        "Agent setup is unavailable: the home folder is unknown."
    );

    let h = Harness::with_agents();
    let home = h.folder.join("home");
    let setup = |payload: Value| {
        let host = h.host.clone();
        async move { host.command("agent-setup", Some(&payload)).await }
    };
    assert_eq!(h.host.command("initialize", None).await.unwrap()["agentSetup"], true);
    // Listing changes nothing, so the offer stands.
    let listed = setup(json!({})).await.unwrap();
    assert_eq!(listed["targets"][0]["id"], "claude");
    assert_eq!(listed["targets"][0]["status"], "missing");
    assert_eq!(
        listed["targets"][1]["folders"],
        json!([home.join(".agents").join("skills").display().to_string()])
    );
    assert_eq!(h.host.command("initialize", None).await.unwrap()["agentSetup"], true);
    for bad in [
        json!({ "install": ["claude", "../elsewhere"] }),
        json!({ "install": "claude" }),
    ] {
        assert_eq!(setup(bad).await.unwrap_err(), "Unknown agent setup target.");
    }
    assert!(!home.exists());

    // Each Terminal Canvas Claude account gets its own copy.
    h.host
        .command("claude-accounts", Some(&json!({ "create": "Work" })))
        .await
        .unwrap();
    let installed = setup(json!({ "install": ["claude"] })).await.unwrap();
    assert_eq!(installed["installed"], json!(["claude"]));
    assert_eq!(installed["targets"][0]["status"], "current");
    assert_eq!(installed["targets"][1]["status"], "missing");
    let skill = |skills: PathBuf| std::fs::read_to_string(skills.join("terminal-canvas").join("SKILL.md")).unwrap();
    assert_eq!(skill(home.join(".claude").join("skills")), tc_core::skills::SKILL);
    assert_eq!(
        skill(h.folder.join("claude-accounts").join("Work").join("skills")),
        tc_core::skills::SKILL
    );
    assert_eq!(
        h.host.command("initialize", None).await.unwrap().get("agentSetup"),
        None
    );

    // Declining the offer installs nothing and is not offered again.
    let h = Harness::with_agents();
    h.host
        .command("agent-setup", Some(&json!({ "dismiss": true })))
        .await
        .unwrap();
    assert_eq!(
        h.host.command("initialize", None).await.unwrap().get("agentSetup"),
        None
    );
    assert!(!h.folder.join("home").exists());
}

fn tmux_missing() -> TmuxState {
    TmuxState {
        installed: None,
        plan: Some(Plan {
            manager: "Homebrew",
            command: "'/opt/homebrew/bin/brew' install tmux".into(),
        }),
    }
}
fn tmux_too_old() -> TmuxState {
    TmuxState {
        installed: Some(Installed {
            binary: PathBuf::from("/usr/bin/tmux"),
            version: Some(tc_tmux::Version { major: 3, minor: 2 }),
        }),
        ..tmux_missing()
    }
}
fn tmux_ready() -> TmuxState {
    TmuxState {
        installed: Some(Installed {
            binary: PathBuf::from("/usr/bin/tmux"),
            version: Some(tc_tmux::Version { major: 3, minor: 8 }),
        }),
        ..tmux_missing()
    }
}
fn tmux_uninstallable() -> TmuxState {
    TmuxState::default()
}

#[tokio::test]
async fn the_tmux_setup_reports_tmux_and_is_offered_until_answered() {
    // Test builds have no tmux setup: nothing is detected, offered, or installed.
    let h = Harness::new();
    assert_eq!(h.host.command("initialize", None).await.unwrap().get("tmuxSetup"), None);
    assert_eq!(
        h.host.command("tmux-setup", Some(&json!({}))).await.unwrap_err(),
        "The tmux setup is unavailable in this build."
    );

    let h = Harness::with_tmux(tmux_missing);
    let marker = h.folder.join("tmux-setup.json");
    assert_eq!(h.host.command("initialize", None).await.unwrap()["tmuxSetup"], true);
    let status = h.host.command("tmux-setup", Some(&json!({}))).await.unwrap();
    assert_eq!(
        status,
        json!({
            "installed": false, "path": null, "version": null, "minimum": "3.3",
            "manager": "Homebrew", "command": "'/opt/homebrew/bin/brew' install tmux",
        })
    );
    // Looking changes nothing, so the offer stands.
    assert!(!marker.exists());
    assert_eq!(h.host.command("initialize", None).await.unwrap()["tmuxSetup"], true);
    // Starting the install answers the offer; the command itself runs in a terminal.
    let install = h
        .host
        .command("tmux-setup", Some(&json!({ "install": true })))
        .await
        .unwrap();
    assert_eq!(install, status);
    assert!(marker.exists());
    assert_eq!(h.host.command("initialize", None).await.unwrap().get("tmuxSetup"), None);

    // Declining is remembered too.
    let h = Harness::with_tmux(tmux_too_old);
    assert_eq!(h.host.command("initialize", None).await.unwrap()["tmuxSetup"], true);
    let status = h
        .host
        .command("tmux-setup", Some(&json!({ "dismiss": true })))
        .await
        .unwrap();
    assert_eq!(
        (&status["installed"], &status["version"]),
        (&json!(false), &json!("3.2"))
    );
    assert_eq!(h.host.command("initialize", None).await.unwrap().get("tmuxSetup"), None);

    // A usable tmux is not offered, but the setup still reports it.
    let h = Harness::with_tmux(tmux_ready);
    assert_eq!(h.host.command("initialize", None).await.unwrap().get("tmuxSetup"), None);
    let status = h.host.command("tmux-setup", Some(&json!({}))).await.unwrap();
    assert_eq!(
        (&status["installed"], &status["path"], &status["version"]),
        (&json!(true), &json!("/usr/bin/tmux"), &json!("3.8"))
    );

    // Without a package manager there is nothing to offer or run.
    let h = Harness::with_tmux(tmux_uninstallable);
    assert_eq!(h.host.command("initialize", None).await.unwrap().get("tmuxSetup"), None);
    assert_eq!(
        h.host
            .command("tmux-setup", Some(&json!({ "install": true })))
            .await
            .unwrap_err(),
        "No supported package manager was found to install tmux."
    );
    assert!(!h.folder.join("tmux-setup.json").exists());
}

#[test]
fn keeping_terminals_running_is_off_until_saved_and_keeps_other_settings() {
    use tc_core::Platform as Os;
    use tc_pty::manager::Keeper;
    use terminal_canvas::host::KeepRunning;
    let folder = std::env::temp_dir().join(format!("tc-settings-{}", uuid::Uuid::new_v4()));
    let file = folder.join("settings.json");
    assert_eq!(KeepRunning::read(&file), KeepRunning::default());
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(&file, r#"{"tmuxProgram":"/opt/tmux","other":1}"#).unwrap();
    let mut setting = KeepRunning::read(&file);
    assert!(!setting.enabled);
    assert_eq!(setting.tmux_program, Some(PathBuf::from("/opt/tmux")));
    setting.enabled = true;
    setting.write(&file).unwrap();
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(
        saved,
        json!({ "tmuxProgram": "/opt/tmux", "other": 1, "keepRunning": true })
    );
    assert!(KeepRunning::read(&file).enabled);
    // An unreadable file turns it off rather than failing startup.
    std::fs::write(&file, "not json").unwrap();
    assert_eq!(KeepRunning::read(&file), KeepRunning::default());

    // Windows keeps terminals in the app's helper, which needs tc-hook; elsewhere tmux must be found.
    let mut paths = Paths {
        data: folder.clone(),
        hook: Some(folder.join("tc-hook.exe")),
        agents: None,
        tmux: None,
    };
    let env = Default::default();
    assert!(matches!(
        setting.keeper(&paths, &env, Os::Windows),
        Ok(Keeper::Daemon(_))
    ));
    paths.hook = None;
    assert_eq!(
        setting.keeper(&paths, &env, Os::Windows).err(),
        Some(terminal_canvas::host::KEEPER_MISSING)
    );
    let missing = KeepRunning {
        enabled: true,
        tmux_program: Some(folder.join("missing")),
    };
    assert_eq!(
        missing.keeper(&paths, &env, Os::Linux).err(),
        Some(terminal_canvas::host::TMUX_MISSING)
    );
    let tmux = folder.join("tmux");
    std::fs::write(&tmux, b"").unwrap();
    let found = KeepRunning {
        enabled: true,
        tmux_program: Some(tmux.clone()),
    };
    assert!(matches!(found.keeper(&paths, &env, Os::MacOs), Ok(Keeper::Tmux(found)) if found.program == tmux));
    std::fs::remove_dir_all(folder).unwrap();
}
