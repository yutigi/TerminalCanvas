//! The terminal-manager tests from `tests/terminal-manager.test.cjs`, on a fake backend.
//!
//! Three JavaScript tests fed real folders through Windows `file://` decoding and were skipped off
//! Windows. These ports report the folders with OSC 9;9, which carries a plain path, so they run on
//! every OS.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tc_core::Platform;
use tc_core::workspace::create_card;
use tc_pty::integration::Integration;
use tc_pty::manager::{
    Backend, Config, DirectoryChoice, DirectoryRequest, EventSink, ExitStatus, Integrations, Process, SessionEvent,
    SessionKey, SpawnRequest, TerminalManager,
};

#[derive(Default)]
struct ProcessState {
    key: Option<SessionKey>,
    pid: u32,
    writes: Vec<String>,
    sizes: Vec<(u16, u16)>,
    pauses: u32,
    resumes: u32,
    acknowledged: usize,
    killed: bool,
    dropped: bool,
    fail_writes: bool,
}

struct Watcher {
    pid: u32,
    key: SessionKey,
    disposed: Arc<Mutex<bool>>,
}

#[derive(Default)]
struct BackendState {
    launches: Vec<SpawnRequest>,
    processes: Vec<Arc<Mutex<ProcessState>>>,
    watchers: Vec<Watcher>,
    fail_writes: bool,
}

struct FakeBackend(Arc<Mutex<BackendState>>);
struct FakeProcess(Arc<Mutex<ProcessState>>);
struct WatchGuard(Arc<Mutex<bool>>);

impl Drop for WatchGuard {
    fn drop(&mut self) {
        *self.0.lock().unwrap() = true;
    }
}

impl Backend for FakeBackend {
    fn spawn(&mut self, request: &SpawnRequest, key: SessionKey, _events: EventSink) -> io::Result<Box<dyn Process>> {
        let mut state = self.0.lock().unwrap();
        state.launches.push(request.clone());
        let process = Arc::new(Mutex::new(ProcessState {
            key: Some(key),
            pid: 100 + state.processes.len() as u32,
            fail_writes: state.fail_writes,
            ..ProcessState::default()
        }));
        state.processes.push(Arc::clone(&process));
        Ok(Box::new(FakeProcess(process)))
    }

    fn watch_directory(&mut self, pid: u32, _platform: Platform, key: SessionKey, _events: EventSink) -> Box<dyn Send> {
        let disposed = Arc::new(Mutex::new(false));
        self.0.lock().unwrap().watchers.push(Watcher {
            pid,
            key,
            disposed: Arc::clone(&disposed),
        });
        Box::new(WatchGuard(disposed))
    }
}

impl Process for FakeProcess {
    fn pid(&self) -> Option<u32> {
        Some(self.0.lock().unwrap().pid)
    }
    fn write(&mut self, data: &str) -> io::Result<()> {
        let mut state = self.0.lock().unwrap();
        if state.fail_writes {
            return Err(io::Error::other("write failed"));
        }
        state.writes.push(data.to_owned());
        Ok(())
    }
    fn resize(&mut self, cols: u16, rows: u16) -> io::Result<()> {
        self.0.lock().unwrap().sizes.push((cols, rows));
        Ok(())
    }
    fn pause(&mut self) {
        self.0.lock().unwrap().pauses += 1;
    }
    fn resume(&mut self) {
        self.0.lock().unwrap().resumes += 1;
    }
    fn acknowledge(&mut self, units: usize) {
        self.0.lock().unwrap().acknowledged += units;
    }
    fn kill(&mut self) {
        self.0.lock().unwrap().killed = true;
    }
}

impl Drop for FakeProcess {
    fn drop(&mut self) {
        self.0.lock().unwrap().dropped = true;
    }
}

struct Harness {
    manager: TerminalManager,
    state: Arc<Mutex<BackendState>>,
    events: Vec<Value>,
}

fn cwd() -> String {
    std::env::current_dir().unwrap().to_string_lossy().into_owned()
}

fn config(platform: Platform, env: &[(&str, &str)]) -> Config {
    Config {
        platform,
        env: env
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect::<BTreeMap<_, _>>(),
        home: cwd(),
        hostname: "TC-Host".into(),
        process_cwd: cwd(),
    }
}

const WINDOWS_ENV: &[(&str, &str)] = &[
    ("SystemRoot", "C:\\Windows"),
    ("ComSpec", "cmd.exe"),
    ("ELECTRON_RUN_AS_NODE", "1"),
    ("SAMPLE", "yes"),
];

fn harness_with(config: Config, integrations: Option<Integrations>) -> Harness {
    let state = Arc::new(Mutex::new(BackendState::default()));
    let sink: EventSink = Arc::new(|_, _| {});
    let manager = TerminalManager::new(config, Box::new(FakeBackend(Arc::clone(&state))), integrations, sink);
    Harness {
        manager,
        state,
        events: Vec::new(),
    }
}

fn harness() -> Harness {
    harness_with(config(Platform::Windows, WINDOWS_ENV), None)
}

impl Harness {
    fn process(&self, index: usize) -> Arc<Mutex<ProcessState>> {
        Arc::clone(&self.state.lock().unwrap().processes[index])
    }
    fn key(&self, index: usize) -> SessionKey {
        self.process(index).lock().unwrap().key.clone().unwrap()
    }
    fn launch(&self, index: usize) -> SpawnRequest {
        self.state.lock().unwrap().launches[index].clone()
    }
    fn launches(&self) -> usize {
        self.state.lock().unwrap().launches.len()
    }
    fn writes(&self, index: usize) -> Vec<String> {
        self.process(index).lock().unwrap().writes.clone()
    }
    fn data(&mut self, index: usize, text: &str) {
        let key = self.key(index);
        self.manager.handle(key, SessionEvent::Output(text.to_owned()));
    }
    fn exit(&mut self, index: usize, code: i64) {
        let key = self.key(index);
        self.manager
            .handle(key, SessionEvent::Exit(ExitStatus { code, signal: None }));
    }
    fn events(&mut self) -> &[Value] {
        for event in self.manager.take_events() {
            self.events.push(serde_json::to_value(event).unwrap());
        }
        &self.events
    }
    fn of_type(&mut self, kind: &str) -> Vec<Value> {
        self.events()
            .iter()
            .filter(|event| event["type"] == kind)
            .cloned()
            .collect()
    }
    fn start(&mut self, card: &Value) -> tc_core::Result<tc_pty::Started> {
        self.manager.start(card, None, None, None)
    }
    fn start_mode(&mut self, card: &Value, mode: &str) -> tc_core::Result<tc_pty::Started> {
        self.manager
            .start(card, Some(&json!(80)), Some(&json!(24)), Some(&json!(mode)))
    }
    fn directory(&mut self, card: &Value) -> DirectoryChoice {
        match self.manager.directory(card).unwrap() {
            DirectoryRequest::Ready(choice) => choice,
            DirectoryRequest::Lookup(lookup) => {
                let current = tc_pty::cwd::process_directory(lookup.pid, lookup.platform);
                self.manager.finish_directory(lookup, current)
            }
        }
    }
    fn snapshot(&mut self, id: &str) -> Value {
        let metadata = self.manager.snapshot().get(id).cloned().unwrap();
        json!({ "cwd": metadata.cwd, "session": metadata.session })
    }
}

fn card(options: Value) -> Value {
    serde_json::to_value(create_card(&options).unwrap()).unwrap()
}

fn id(card: &Value) -> &str {
    card["id"].as_str().unwrap()
}

fn this_file() -> String {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/manager.rs")
        .to_string_lossy()
        .into_owned()
}

const SAVED_ID: &str = "12345678-1234-4321-9876-123456789abc";

fn saved_session(provider: &str) -> Value {
    json!({ "provider": provider, "sessionId": SAVED_ID, "cwd": cwd() })
}

fn with_session(mut card: Value, session: Value) -> Value {
    card["session"] = session;
    card
}

fn metadata_event(event: Value) -> String {
    use base64::Engine;
    format!(
        "\x1b]633;TC;{}\x07",
        base64::engine::general_purpose::STANDARD.encode(event.to_string())
    )
}

fn arg_after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.iter()
        .position(|arg| arg == flag)
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
}

#[test]
fn does_not_launch_until_started_and_sends_the_command_once() {
    let mut h = harness();
    let card = card(json!({ "profile": "codex" }));
    assert_eq!(h.launches(), 0);
    h.manager
        .start(&card, Some(&json!(100)), Some(&json!(30)), None)
        .unwrap();
    assert_eq!(h.writes(0), ["codex\r"]);
    let launch = h.launch(0);
    assert_eq!(
        launch.shell,
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    );
    assert_eq!(
        launch.args[..5],
        [
            "-NoLogo",
            "-NoExit",
            "-ExecutionPolicy",
            "RemoteSigned",
            "-EncodedCommand"
        ]
    );
    assert_eq!(launch.env.get("ELECTRON_RUN_AS_NODE"), None);
    assert_eq!(launch.env["SAMPLE"], "yes");
    assert_eq!(launch.env["TERM"], "xterm-256color");
    assert_eq!(launch.env["COLORTERM"], "truecolor");
    assert_eq!(launch.env["TERMINAL_CANVAS"], "1");
    assert_eq!((launch.cols, launch.rows), (100, 30));
    assert_eq!(launch.cwd, cwd());
}

#[test]
fn shell_initialization_runs_before_a_saved_ai_command_or_resume() {
    let integrations: Integrations = Box::new(|_, _| {
        Ok(Some(Integration::new(
            Some(vec!["--login".into(), "-i".into()]),
            Some("source '/integration.bash'".into()),
            std::env::temp_dir().join("tc-unused-session.json"),
            Vec::new(),
        )))
    });
    let mut h = harness_with(config(Platform::Linux, &[("SHELL", "/bin/bash")]), Some(integrations));
    h.start(&card(json!({ "profile": "codex" }))).unwrap();
    assert_eq!(h.launch(0).args, ["--login", "-i"]);
    assert_eq!(h.writes(0), ["source '/integration.bash'\r", "codex\r"]);
    let resumable = with_session(
        card(json!({})),
        json!({ "provider": "codex", "sessionId": SAVED_ID, "cwd": cwd() }),
    );
    h.start_mode(&resumable, "resume").unwrap();
    assert_eq!(
        h.writes(1),
        [
            "source '/integration.bash'\r".to_owned(),
            format!("codex resume {SAVED_ID}\r")
        ]
    );
    h.manager.stop_all();
}

#[test]
fn uses_windows_powershell_from_system_root() {
    let mut h = harness_with(
        config(
            Platform::Windows,
            &[("SystemRoot", "D:\\Windows"), ("ComSpec", "cmd.exe")],
        ),
        None,
    );
    let started = h.start(&card(json!({}))).unwrap();
    assert_eq!(
        started.shell,
        "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    );
    assert_eq!(h.launch(0).shell, started.shell);
    assert_eq!(
        h.launch(0).args[..5],
        [
            "-NoLogo",
            "-NoExit",
            "-ExecutionPolicy",
            "RemoteSigned",
            "-EncodedCommand"
        ]
    );
    assert!(h.writes(0).is_empty());
}

#[test]
fn falls_back_to_the_standard_powershell_path_without_system_root() {
    let mut h = harness_with(config(Platform::Windows, &[]), None);
    assert_eq!(
        h.start(&card(json!({}))).unwrap().shell,
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    );
}

#[test]
fn powershell_cards_and_launchers_allow_local_scripts() {
    for command in ["", "powershell", "pwsh.exe"] {
        let mut h = harness();
        h.start(&card(json!({ "command": command }))).unwrap();
        assert_eq!(
            arg_after(&h.launch(0).args, "-ExecutionPolicy"),
            Some("RemoteSigned"),
            "{command}"
        );
    }
    let mut h = harness();
    h.start(&card(json!({ "command": "cmd.exe" }))).unwrap();
    assert!(!h.launch(0).args.iter().any(|arg| arg == "-ExecutionPolicy"));
}

#[test]
fn keeps_the_login_shell_and_bash_fallback_elsewhere() {
    for env in [&[("SHELL", "/bin/zsh")][..], &[][..], &[("SHELL", "")][..]] {
        let mut h = harness_with(config(Platform::Linux, env), None);
        let expected = env
            .first()
            .map(|(_, shell)| *shell)
            .filter(|shell| !shell.is_empty())
            .unwrap_or("/bin/bash");
        assert_eq!(h.start(&card(json!({}))).unwrap().shell, expected);
        assert_eq!(h.launch(0).args, ["-l"]);
    }
}

#[test]
fn routes_input_and_resize_to_the_right_pty() {
    let mut h = harness();
    let (a, b) = (card(json!({})), card(json!({})));
    h.start(&a).unwrap();
    h.start(&b).unwrap();
    h.manager.write(id(&b), "hello").unwrap();
    h.manager.resize(id(&a), &json!(120), &json!(40)).unwrap();
    h.data(0, "first");
    h.data(1, "second");
    assert!(h.writes(0).is_empty());
    assert_eq!(h.writes(1), ["hello"]);
    assert_eq!(h.process(0).lock().unwrap().sizes, [(120, 40)]);
    let ids: Vec<Value> = h.of_type("data").iter().map(|event| event["id"].clone()).collect();
    assert_eq!(ids, [a["id"].clone(), b["id"].clone()]);
}

#[test]
fn backpressure_pauses_at_the_high_watermark_and_resumes_after_acknowledgment() {
    let mut h = harness();
    let card = card(json!({}));
    h.start(&card).unwrap();
    h.data(0, &"a".repeat(260_000));
    h.data(0, "more");
    assert_eq!(h.process(0).lock().unwrap().pauses, 1);
    h.manager.acknowledge(id(&card), &json!(250_000));
    assert_eq!(h.process(0).lock().unwrap().resumes, 1);
    for ignored in [json!(-10), json!(1.5), json!("10"), json!(2_000_000)] {
        h.manager.acknowledge(id(&card), &ignored);
    }
    assert_eq!(h.manager.pending_output(id(&card)), Some(10_004));
    assert_eq!(
        h.process(0).lock().unwrap().acknowledged,
        250_000,
        "valid acknowledgments reach the process"
    );
}

#[test]
fn exited_sessions_are_removed_and_stale_events_ignored_after_a_restart() {
    let mut h = harness();
    let card = card(json!({}));
    h.start(&card).unwrap();
    h.exit(0, 0);
    assert_eq!(h.manager.running(), 0);
    assert!(h.process(0).lock().unwrap().dropped);
    h.start(&card).unwrap();
    h.data(0, "stale");
    h.exit(0, 1);
    assert_eq!(h.manager.running(), 1);
    let others: Vec<Value> = h
        .events()
        .iter()
        .filter(|event| event["type"] != "metadata")
        .cloned()
        .collect();
    assert_eq!(others, [json!({ "type": "exit", "id": card["id"], "exitCode": 0 })]);
}

#[test]
fn stop_and_stop_all_kill_each_child() {
    let mut h = harness();
    let (a, b) = (card(json!({})), card(json!({})));
    h.start(&a).unwrap();
    h.start(&b).unwrap();
    h.manager.stop(id(&a));
    h.manager.stop(id(&a));
    h.manager.stop_all();
    assert_eq!(h.manager.running(), 0);
    assert!((0..2).all(|index| h.process(index).lock().unwrap().killed));
    assert_eq!(h.manager.stopping(), 2);
}

#[test]
fn rejects_duplicate_starts_bad_dimensions_large_input_and_missing_folders() {
    let mut h = harness();
    let card = card(json!({}));
    h.start(&card).unwrap();
    let message = |result: tc_core::Result<tc_pty::Started>| result.unwrap_err().to_string();
    assert!(message(h.start(&card)).contains("already running"));
    assert!(
        h.manager
            .resize(id(&card), &json!(0), &json!(12))
            .unwrap_err()
            .to_string()
            .contains("dimensions")
    );
    let other = self::card(json!({}));
    assert!(message(h.manager.start(&other, Some(&json!(80.5)), Some(&json!(24)), None)).contains("dimensions"));
    assert!(
        message(
            h.manager
                .start(&other, Some(&json!(80)), Some(&json!(24)), Some(&Value::Null))
        )
        .contains("start mode")
    );
    assert_eq!(
        h.manager.write(id(&card), &"a".repeat(65_537)).unwrap_err().to_string(),
        "Input exceeds 64 KB."
    );
    h.manager.write(id(&card), &"🚀".repeat(32_768)).unwrap();
    assert!(
        h.manager.write(id(&card), &"🚀".repeat(32_769)).is_err(),
        "the limit counts UTF-16 units"
    );
    assert!(message(h.start(&self::card(json!({ "cwd": this_file() })))).contains("folder"));
}

#[test]
fn the_terminal_limit_is_24() {
    let mut h = harness();
    for _ in 0..24 {
        h.start(&card(json!({}))).unwrap();
    }
    assert_eq!(
        h.start(&card(json!({}))).unwrap_err().to_string(),
        "Terminal limit reached."
    );
}

#[test]
fn failed_launch_commands_kill_the_new_terminal() {
    let mut h = harness();
    h.state.lock().unwrap().fail_writes = true;
    assert_eq!(
        h.start(&card(json!({ "command": "echo hi" }))).unwrap_err().to_string(),
        "write failed"
    );
    assert_eq!(h.manager.running(), 0);
    assert!(h.process(0).lock().unwrap().killed);
}

#[test]
fn resume_uses_only_the_saved_provider_id_and_folder() {
    for provider in ["codex", "claude"] {
        let mut h = harness();
        let card = with_session(card(json!({ "command": "echo do-not-rerun" })), saved_session(provider));
        h.start_mode(&card, "resume").unwrap();
        assert_eq!(h.launch(0).cwd, cwd());
        let expected = if provider == "codex" {
            "codex resume "
        } else {
            "claude --resume "
        };
        assert_eq!(h.writes(0), [format!("{expected}{SAVED_ID}\r")]);
        h.manager.stop_all();
    }
}

#[test]
fn fresh_shells_never_rerun_a_command_and_fall_back_from_a_missing_folder() {
    let mut h = harness();
    let card = with_session(
        card(json!({ "cwd": this_file(), "command": "claude" })),
        saved_session("codex"),
    );
    h.start_mode(&card, "fresh").unwrap();
    assert!(h.writes(0).is_empty());
    assert_eq!(h.launch(0).cwd, cwd());
    assert_eq!(h.snapshot(id(&card))["session"], saved_session("codex"));
    h.manager.stop_all();
}

#[test]
fn missing_or_unavailable_saved_sessions_keep_the_id_for_retry() {
    let mut h = harness();
    let error = h.start_mode(&card(json!({})), "resume").unwrap_err().to_string();
    assert!(error.contains("No valid saved session"), "{error}");
    let mut session = saved_session("codex");
    session["cwd"] = json!(this_file());
    let error = h
        .start_mode(&with_session(card(json!({})), session), "resume")
        .unwrap_err()
        .to_string();
    assert!(error.contains("unavailable"), "{error}");
    assert_eq!(h.launches(), 0);
}

#[test]
fn manual_launches_keep_ids_and_folders_separate_and_failed_resume_keeps_metadata() {
    let mut h = harness();
    let a = with_session(card(json!({})), saved_session("codex"));
    let b = card(json!({}));
    h.start_mode(&a, "resume").unwrap();
    h.start(&b).unwrap();
    let token = "87654321-4321-4321-9876-123456789abc";
    h.data(
        0,
        &metadata_event(json!({ "type": "launch", "token": token, "provider": "codex", "cwd": cwd() })),
    );
    h.data(
        0,
        &metadata_event(json!({ "type": "end", "token": token, "exitCode": 1 })),
    );
    assert_eq!(h.snapshot(id(&a))["session"], saved_session("codex"));
    assert_eq!(h.of_type("error").len(), 1);
    h.data(
        1,
        &metadata_event(
            json!({ "type": "launch", "token": token, "provider": "claude", "cwd": "/other", "sessionId": token }),
        ),
    );
    assert_eq!(h.snapshot(id(&b))["session"]["provider"], "claude");
    assert_eq!(h.snapshot(id(&b))["session"]["cwd"], "/other");
    assert_eq!(h.snapshot(id(&a))["session"], saved_session("codex"));
    h.manager.stop_all();
}

#[test]
fn shutdown_snapshots_read_the_final_hook_update_and_reject_other_launches() {
    let folder = tempdir("manager");
    let file = folder.join("metadata.json");
    let session_file = file.clone();
    let integrations: Integrations =
        Box::new(move |_, _| Ok(Some(Integration::new(None, None, session_file.clone(), Vec::new()))));
    let mut h = harness_with(config(Platform::Windows, WINDOWS_ENV), Some(integrations));
    let card = card(json!({}));
    h.start(&card).unwrap();
    h.data(
        0,
        &metadata_event(json!({ "type": "launch", "provider": "claude", "token": SAVED_ID, "cwd": cwd() })),
    );
    let mut saved = saved_session("claude");
    saved["token"] = json!("different-launch");
    std::fs::write(&file, saved.to_string()).unwrap();
    assert_eq!(h.snapshot(id(&card))["session"], Value::Null);
    saved["token"] = json!(SAVED_ID);
    std::fs::write(&file, saved.to_string()).unwrap();
    h.manager.stop_all();
    assert_eq!(h.snapshot(id(&card))["session"]["provider"], "claude");
    assert!(!file.exists(), "stopping removes the integration files");
    assert_eq!(h.manager.running(), 0);
    let _ = std::fs::remove_dir_all(folder);
}

#[test]
fn split_prompt_reports_never_change_pty_bytes_or_input() {
    let mut h = harness();
    let (a, b) = (card(json!({})), card(json!({})));
    h.start(&a).unwrap();
    h.start(&b).unwrap();
    let chunks = ["output\x1b]9;", "9;D:\\A folder\\子\x1b", "\\after"];
    for chunk in chunks {
        h.data(1, chunk);
    }
    assert_eq!(
        h.of_type("cwd"),
        [json!({ "type": "cwd", "id": b["id"], "cwd": "D:\\A folder\\子" })]
    );
    let data: Vec<Value> = h.of_type("data").iter().map(|event| event["data"].clone()).collect();
    assert_eq!(data, chunks.map(Value::from));
    assert_eq!(
        h.manager.pending_output(id(&b)),
        Some(tc_core::js::utf16_len(&chunks.concat()))
    );
    h.data(1, "\x1b]9;9;\x07");
    assert_eq!(h.events().last().unwrap()["cwd"], Value::Null);
    h.manager.write(id(&a), "cd \"ignored input\"\r").unwrap();
    assert_eq!(h.writes(0), ["cd \"ignored input\"\r"]);
    assert_eq!(h.of_type("cwd").len(), 2);
}

#[test]
fn plain_windows_shell_launchers_receive_the_matching_integration() {
    for command in ["pwsh", "powershell.exe", "cmd.exe"] {
        let mut h = harness();
        h.start(&card(json!({ "command": command }))).unwrap();
        let launch = h.launch(0);
        assert_eq!(launch.shell, if command == "pwsh" { "pwsh.exe" } else { command });
        assert_eq!(launch.env["PROMPT"], "$E]9;9;$P$E\\$P$G");
        assert!(h.writes(0).is_empty());
        assert_eq!(launch.args.iter().any(|arg| arg == "-NoExit"), command != "cmd.exe");
    }
}

#[test]
fn process_lookups_are_scoped_to_sessions_and_disposed_on_exit() {
    let mut h = harness_with(config(Platform::Linux, &[]), None);
    let (a, b) = (card(json!({})), card(json!({})));
    h.start(&a).unwrap();
    h.start(&b).unwrap();
    let watcher = |h: &Harness, index: usize| {
        let state = h.state.lock().unwrap();
        let watcher = &state.watchers[index];
        (watcher.pid, watcher.key.clone(), Arc::clone(&watcher.disposed))
    };
    let (pid, key, _) = watcher(&h, 1);
    for _ in 0..2 {
        h.manager
            .handle(key.clone(), SessionEvent::Directory(Some("/folder with spaces".into())));
    }
    assert_eq!(
        h.of_type("cwd"),
        [json!({ "type": "cwd", "id": b["id"], "cwd": "/folder with spaces" })]
    );
    assert_eq!(h.snapshot(id(&b))["cwd"], "/folder with spaces");
    assert_eq!(pid, h.process(1).lock().unwrap().pid);
    h.exit(0, 0);
    h.start(&a).unwrap();
    let (_, old_key, old_disposed) = watcher(&h, 0);
    h.manager
        .handle(old_key, SessionEvent::Directory(Some("/stale".into())));
    assert_eq!(h.of_type("cwd").len(), 1);
    assert!(*old_disposed.lock().unwrap());
    h.manager.stop_all();
    assert!(
        h.state
            .lock()
            .unwrap()
            .watchers
            .iter()
            .all(|watcher| *watcher.disposed.lock().unwrap())
    );
}

/// A Windows prompt report: OSC 9;9 with the folder, then the readiness marker.
fn report(cwd: &str, ready: bool) -> String {
    format!("\x1b]9;9;{cwd}\x07\x1b]777;tc-ready;{}\x07", u8::from(ready))
}

fn tempdir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tc-pty-{label}-{}", uuid()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.canonicalize().unwrap()
}

fn uuid() -> String {
    format!(
        "{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    )
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[test]
fn tracks_directories_per_windows_session_without_typing_or_copying_ai_processes() {
    let root = tempdir("directory");
    let nested = root.join("nested space").join("project's 日本語");
    std::fs::create_dir_all(&nested).unwrap();
    let mut config = config(Platform::Windows, WINDOWS_ENV);
    config.home = text(&root);
    let mut h = harness_with(config, None);
    let a = card(json!({ "profile": "codex", "cwd": text(&root) }));
    let b = card(json!({ "cwd": text(&root) }));
    h.start(&a).unwrap();
    h.start(&b).unwrap();
    h.data(0, &report(&text(&root), false));
    assert!(
        h.directory(&a).warning.is_some(),
        "a queued AI launch must not reuse the startup prompt"
    );
    h.data(0, &report(&text(&nested), true));
    h.data(1, &report(&text(&root), true));
    assert_eq!(h.directory(&a).cwd, text(&nested));
    assert_eq!(h.directory(&b).cwd, text(&root));
    let duplicate = card(json!({ "profile": "shell", "command": "", "cwd": h.directory(&a).cwd }));
    h.start(&duplicate).unwrap();
    assert_eq!(h.launch(2).cwd, text(&nested));
    assert_eq!(h.writes(0), ["codex\r"]);
    assert!(h.writes(2).is_empty());
    assert!(!h.of_type("cwd").is_empty(), "the directory display keeps updating");
    h.manager.write(id(&a), "cd somewhere\r").unwrap();
    assert!(h.directory(&a).warning.unwrap().contains("could not be determined"));
    h.data(0, &report(&text(&root), true));
    assert_eq!(h.directory(&a).warning, None);
    h.manager.stop(id(&a));
    assert!(h.directory(&a).warning.unwrap().contains("stopped"));
    h.start(&a).unwrap();
    assert!(
        h.directory(&a).warning.unwrap().contains("could not be determined"),
        "a restart forgets the old folder"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn missing_current_directories_offer_the_launch_folder_then_home() {
    let root = tempdir("fallback");
    let (launch, current) = (root.join("launch"), root.join("deleted directory"));
    std::fs::create_dir(&launch).unwrap();
    std::fs::create_dir(&current).unwrap();
    let mut config = config(Platform::Windows, WINDOWS_ENV);
    config.home = text(&root);
    let mut h = harness_with(config, None);
    let card = card(json!({ "cwd": text(&launch) }));
    h.start(&card).unwrap();
    h.data(0, &report(&text(&current), true));
    std::fs::remove_dir(&current).unwrap();
    assert_eq!(h.directory(&card).cwd, text(&launch));
    assert!(h.directory(&card).warning.unwrap().contains("no longer available"));
    std::fs::remove_dir(&launch).unwrap();
    assert_eq!(h.directory(&card).cwd, text(&root));
    h.data(0, &report("", true));
    assert!(h.directory(&card).warning.unwrap().contains("could not be determined"));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn unix_duplicates_ask_the_shell_process_and_unknown_folders_need_review() {
    let mut h = harness_with(config(Platform::current(), &[]), None);
    if Platform::current().is_windows() {
        return;
    }
    let card = card(json!({}));
    h.start(&card).unwrap();
    h.process(0).lock().unwrap().pid = std::process::id();
    let choice = h.directory(&card);
    if matches!(Platform::current(), Platform::Linux | Platform::MacOs) {
        assert_eq!(
            Path::new(&choice.cwd).canonicalize().unwrap(),
            Path::new(&cwd()).canonicalize().unwrap()
        );
        assert_eq!(choice.warning, None);
    }
    let mut mac = harness_with(config(Platform::MacOs, &[]), None);
    mac.start(&card).unwrap();
    let DirectoryRequest::Lookup(lookup) = mac.manager.directory(&card).unwrap() else {
        panic!("macOS asks the process")
    };
    assert!(mac.manager.finish_directory(lookup, None).warning.is_some());
}

#[test]
fn queued_windows_input_requires_an_idle_prompt() {
    let mut h = harness();
    let card = card(json!({ "cwd": cwd() }));
    h.start(&card).unwrap();
    h.data(0, &report(&cwd(), true));
    assert_eq!(h.directory(&card).warning, None);
    h.manager
        .write(id(&card), "cd first\rcd second; Start-Sleep 2\r")
        .unwrap();
    h.data(0, &report(&cwd(), false));
    assert_eq!(
        h.manager.live_directory(id(&card)),
        Some(Some(cwd())),
        "the live display keeps its last report"
    );
    assert!(h.directory(&card).warning.unwrap().contains("could not be determined"));
    h.data(0, &report(&cwd(), true));
    assert_eq!(
        h.directory(&card).warning,
        None,
        "the final idle prompt restores duplication"
    );
}

#[test]
fn lookups_discard_results_from_a_stopped_or_restarted_session() {
    let mut h = harness_with(config(Platform::Linux, &[]), None);
    let card = card(json!({}));
    h.start(&card).unwrap();
    let DirectoryRequest::Lookup(lookup) = h.manager.directory(&card).unwrap() else {
        panic!("Linux asks the process")
    };
    h.manager.stop(id(&card));
    h.start(&card).unwrap();
    let choice = h.manager.finish_directory(lookup, Some(cwd()));
    assert!(choice.warning.unwrap().contains("could not be determined"));
    h.manager.stop_all();
}

#[test]
fn shutdown_waits_for_every_killed_pty_to_exit() {
    let mut h = harness();
    h.start(&card(json!({}))).unwrap();
    h.start(&card(json!({}))).unwrap();
    h.manager.begin_shutdown(Duration::from_secs(5));
    assert!((0..2).all(|index| h.process(index).lock().unwrap().killed));
    assert_eq!(h.manager.running(), 0);
    assert_eq!(h.manager.stopping(), 2);
    h.exit(0, 0);
    assert_eq!(h.manager.stopping(), 1, "the second PTY still owns native resources");
    h.exit(1, 0);
    assert_eq!(h.manager.stopping(), 0);
    assert!(
        h.of_type("exit").is_empty(),
        "stopped terminals report no exit to the UI"
    );
}

#[test]
fn shutdown_gives_up_on_a_pty_that_never_exits() {
    let mut h = harness();
    h.start(&card(json!({}))).unwrap();
    h.manager.begin_shutdown(Duration::from_millis(10));
    assert!(h.manager.next_stop_deadline().is_some());
    std::thread::sleep(Duration::from_millis(30));
    assert_eq!(h.manager.stopping(), 0);
    assert_eq!(h.manager.running(), 0);
}

#[test]
fn shutdown_also_waits_for_terminals_stopped_earlier() {
    let mut h = harness();
    let card = card(json!({}));
    h.start(&card).unwrap();
    h.manager.stop(id(&card));
    h.manager.begin_shutdown(Duration::from_secs(5));
    assert_eq!(h.manager.stopping(), 1);
    h.exit(0, 0);
    assert_eq!(h.manager.stopping(), 0);
}

#[test]
fn windows_reports_keep_the_last_valid_recovery_folder_and_conversation() {
    let mut h = harness();
    let card = with_session(card(json!({})), saved_session("codex"));
    h.start(&card).unwrap();
    h.data(0, "\x1b]9;9;D:\\changed folder\\子\x07");
    assert_eq!(
        h.snapshot(id(&card)),
        json!({ "cwd": "D:\\changed folder\\子", "session": saved_session("codex") })
    );
    h.data(0, "\x1b]7;\x07");
    assert_eq!(h.snapshot(id(&card))["cwd"], "D:\\changed folder\\子");
    h.manager.stop_all();
}

#[test]
fn events_serialize_like_the_javascript_host() {
    let mut h = harness();
    let card = card(json!({ "cwd": cwd() }));
    let started = h.start(&card).unwrap();
    assert_eq!(
        serde_json::to_value(&started).unwrap(),
        json!({ "id": card["id"], "pid": 100, "cwd": cwd(), "shell": started.shell, "session": null })
    );
    assert_eq!(
        h.events()[0],
        json!({ "type": "metadata", "id": card["id"], "cwd": cwd(), "session": null, "initial": true })
    );
    h.data(0, &metadata_event(json!({ "type": "warning", "message": "careful" })));
    assert_eq!(
        h.of_type("error"),
        [json!({ "type": "error", "id": card["id"], "message": "careful" })]
    );
}
