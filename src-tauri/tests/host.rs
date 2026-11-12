//! OS boundary and recovery parity, exercised without a webview or real child processes.
use std::collections::VecDeque;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tc_core::workspace::{create_card, create_workspace};
use tc_pty::manager::{Backend, Config, EventSink, ExitStatus, Process, SessionEvent, SessionKey, SpawnRequest};
use terminal_canvas::host::{BoxFuture, FileKind, Host, Paths, Platform};

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
    fn spawn(&mut self, _: &SpawnRequest, key: SessionKey, events: EventSink) -> io::Result<Box<dyn Process>> {
        let state = Arc::new(Mutex::new(FakeProcess::default()));
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
    fn new() -> Self {
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
                hook: None,
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
async fn clipboard_limits_count_utf16_and_os_failures_reach_the_renderer() {
    let h = Harness::new();
    *h.platform.clipboard.lock().unwrap() = "first\nsecond".into();
    assert_eq!(
        h.host.command("clipboard-read", None).await.unwrap(),
        json!({"text":"first\nsecond"})
    );
    *h.platform.clipboard.lock().unwrap() = "😀".repeat(32000);
    assert!(h.host.command("clipboard-read", None).await.is_ok());
    h.platform.clipboard.lock().unwrap().push('x');
    assert_eq!(
        h.host.command("clipboard-read", None).await.unwrap_err(),
        "Paste is limited to 64,000 characters."
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
        assert!(restored.get("warning").is_none(), "{input}: {restored}");
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
        json!({ "status": "opened", "card": card_id, "parent": "parent-card", "log": log.to_string_lossy() })
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
