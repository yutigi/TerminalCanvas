//! `tc-hook` matches `src/session-hook.cjs` (`tests/golden/hook.json`), and the shell integration
//! reports launches through it end to end.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::{Value, json};
use tc_core::Platform;
use tc_core::session::{MetadataEvent, MetadataParser};

const HOOK: &str = env!("CARGO_BIN_EXE_tc-hook");

fn golden() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/golden/hook.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn temp_folder(label: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let folder = std::env::temp_dir().join(format!("tc-hook-{label}-{nanos}"));
    std::fs::create_dir_all(&folder).unwrap();
    // Keep shell-facing Windows paths compatible with cmd/PowerShell; std::canonicalize
    // adds a verbatim namespace prefix that those command-discovery paths cannot use.
    dunce::canonicalize(folder).unwrap()
}

/// The JSON event inside `\x1b]633;TC;<base64>\x07`.
fn decode_report(output: &[u8]) -> Value {
    let text = std::str::from_utf8(output).unwrap();
    let encoded = text
        .strip_prefix("\x1b]633;TC;")
        .and_then(|rest| rest.strip_suffix('\x07'))
        .expect("one OSC 633 report");
    serde_json::from_slice(&tc_core::node::base64_decode(encoded)).unwrap()
}

fn hook(args: &[&str], folder: &Path) -> Command {
    let mut command = Command::new(HOOK);
    command
        .args(args)
        .current_dir(folder)
        .env_remove("TC_LAUNCH_TOKEN")
        .env_remove("TC_SESSION_FILE")
        .env_remove(tc_core::launch::ENV)
        .env_remove(tc_core::launch::CARD_ENV)
        // Never reach the real app's data folder from a test.
        .env(tc_core::launch::DATA_ENV, folder.join("no-app-data"));
    command
}

#[test]
fn emit_matches_the_javascript_hook() {
    let golden = golden();
    let folder = temp_folder("emit");
    for case in golden["emit"].as_array().unwrap() {
        let args: Vec<&str> = case["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|arg| arg.as_str().unwrap())
            .collect();
        let mut command = hook(&[&["emit"], &args[..]].concat(), &folder);
        if let Some(token) = case["token"].as_str() {
            command.env("TC_LAUNCH_TOKEN", token);
        }
        let output = command.output().unwrap();
        assert!(output.status.success(), "{args:?}");
        let mut event = decode_report(&output.stdout);
        if let Some(cwd) = event.get("cwd").and_then(Value::as_str) {
            let same = dunce::canonicalize(cwd).ok() == Some(folder.clone());
            event["cwd"] = json!(if same { "{{CWD}}" } else { "UNEXPECTED" });
        }
        // Field order matters too: compare the JSON text.
        assert_eq!(event.to_string(), case["event"].to_string(), "{args:?}");
    }
    std::fs::remove_dir_all(folder).unwrap();
}

fn record(
    folder: &Path,
    input: &str,
    provider: &str,
    token: Option<&str>,
    session_file: Option<&Path>,
) -> std::process::Output {
    let mut command = hook(&["record", provider], folder);
    if let Some(token) = token {
        command.env("TC_LAUNCH_TOKEN", token);
    }
    if let Some(file) = session_file {
        command.env("TC_SESSION_FILE", file);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    // The hook may stop reading early; a closed pipe is fine.
    let _ = stdin.write_all(input.as_bytes());
    drop(stdin);
    child.wait_with_output().unwrap()
}

#[test]
fn record_matches_the_javascript_hook() {
    let golden = golden();
    let folder = temp_folder("record");
    let file = folder.join("session.json");
    for case in golden["record"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let _ = std::fs::remove_file(&file);
        let session_file = (case["sessionFile"] == true).then_some(file.as_path());
        let output = record(
            &folder,
            &case["input"].to_string(),
            case["provider"].as_str().unwrap(),
            case["token"].as_str(),
            session_file,
        );
        assert!(output.status.success(), "{name}: a hook never blocks the agent");
        let written = std::fs::read_to_string(&file).ok();
        assert_eq!(written.as_deref(), case["written"].as_str(), "{name}");
        assert_eq!(
            std::fs::read_dir(&folder).unwrap().count(),
            usize::from(written.is_some()),
            "{name}: no temporary files"
        );
        #[cfg(unix)]
        if written.is_some() {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o600,
                "{name}"
            );
        }
    }
    std::fs::remove_dir_all(folder).unwrap();
}

#[test]
fn record_accepts_one_utf8_transport_preamble() {
    let folder = temp_folder("utf8-preamble");
    let file = folder.join("session.json");
    let cwd = "/project/ไทย 工作 🚀";
    let input = json!({ "hook_event_name": "SessionStart", "session_id": ID, "cwd": cwd,
        "transcript_path": "MUST_NOT_BE_SAVED" })
    .to_string();
    for prefix in ["", "\u{feff}"] {
        let _ = std::fs::remove_file(&file);
        let output = record(&folder, &format!("{prefix}{input}"), "claude", Some(ID), Some(&file));
        assert!(output.status.success());
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(
            saved,
            json!({ "provider": "claude", "sessionId": ID, "cwd": cwd, "token": ID })
        );
    }
    std::fs::remove_file(&file).unwrap();
    let output = record(
        &folder,
        &format!("\u{feff}\u{feff}{input}"),
        "claude",
        Some(ID),
        Some(&file),
    );
    assert!(output.status.success(), "malformed hook input must remain nonblocking");
    assert!(!file.exists(), "only one transport signature is accepted");
    std::fs::remove_dir_all(folder).unwrap();
}

#[test]
fn record_ignores_malformed_and_oversized_input() {
    let folder = temp_folder("malformed");
    let file = folder.join("session.json");
    let token = golden()["token"].as_str().unwrap().to_owned();
    let valid = json!({ "hook_event_name": "SessionStart", "session_id": "12345678-1234-4321-9876-123456789abc", "cwd": "/project" });
    let padded = |units: usize| {
        let mut input = valid.clone();
        let base = input.to_string().len() + r#","pad":"""#.len();
        input["pad"] = json!("x".repeat(units - base));
        input.to_string()
    };
    for (input, recorded) in [
        ("not json".to_owned(), false),
        ("".to_owned(), false),
        (padded(65_536), true),
        (padded(65_537), false),
        (format!("\u{feff}{}", padded(65_536)), true),
        (format!("\u{feff}{}", padded(65_537)), false),
        (format!("{}{}", padded(65_536), " ".repeat(300_000)), false),
    ] {
        let _ = std::fs::remove_file(&file);
        let output = record(&folder, &input, "claude", Some(&token), Some(&file));
        assert!(output.status.success());
        assert_eq!(file.exists(), recorded, "input of {} bytes", input.len());
    }
    std::fs::remove_dir_all(folder).unwrap();
}

#[test]
fn unknown_commands_print_usage() {
    let output = Command::new(HOOK).arg("help").output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("usage: tc-hook"));
}

/// Launch and end events the integration reported, decoded as the host decodes them.
fn launches(stdout: &[u8], platform: Platform) -> (Vec<Value>, Vec<Value>) {
    let mut parser = MetadataParser::new("/start", platform, false);
    let (mut launches, mut ends) = (Vec::new(), Vec::new());
    parser.feed(&String::from_utf8_lossy(stdout), &mut |event| match event {
        MetadataEvent::Launch(event) => launches.push(event),
        MetadataEvent::End(event) => ends.push(event),
        _ => {}
    });
    (launches, ends)
}

const ID: &str = "12345678-1234-4321-9876-123456789abc";

#[test]
fn codex_start_hook_records_only_recovery_metadata_before_exit() {
    let folder = temp_folder("codex-start");
    let file = folder.join("session.json");
    let config = tc_pty::shell::codex_hook_config(cfg!(windows));
    let command = config
        .strip_prefix("hooks.SessionStart=[{hooks=[{type='command',command='")
        .unwrap()
        .strip_suffix("',timeout=5}]}]")
        .unwrap();
    let mut shell = if cfg!(windows) {
        let mut shell = Command::new("cmd.exe");
        shell.args(["/d", "/s", "/c", command]);
        shell
    } else {
        let mut shell = Command::new("/bin/sh");
        shell.args(["-c", command]);
        shell
    };
    let cwd = folder.join("ไทย 工作 🚀");
    let payload = json!({ "hook_event_name": "SessionStart", "session_id": ID.to_uppercase(),
        "cwd": cwd, "source": "startup", "transcript_path": "MUST_NOT_BE_SAVED", "model": "private" });
    let mut child = shell
        .env("TC_HOOK", dunce::simplified(Path::new(HOOK)))
        .env("TC_LAUNCH_TOKEN", ID)
        .env("TC_SESSION_FILE", &file)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(payload.to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert!(output.stdout.is_empty(), "hooks must not inject model context");
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(
        saved,
        json!({ "provider": "codex", "sessionId": ID, "cwd": cwd, "token": ID })
    );
    for event in ["SessionEnd", "Stop", "SubagentStart"] {
        let mut invalid = payload.clone();
        invalid["hook_event_name"] = event.into();
        invalid["session_id"] = "87654321-4321-4321-9876-123456789abc".into();
        assert!(
            record(&folder, &invalid.to_string(), "codex", Some(ID), Some(&file))
                .status
                .success()
        );
        assert_eq!(
            serde_json::from_str::<Value>(&std::fs::read_to_string(&file).unwrap()).unwrap(),
            saved
        );
    }
    std::fs::remove_dir_all(folder).unwrap();
}

#[cfg(unix)]
#[test]
fn bash_wrappers_report_manual_launches_through_tc_hook() {
    use std::os::unix::fs::PermissionsExt;
    let bash = Path::new("/bin/bash");
    if !bash.exists() {
        return;
    }
    let folder = temp_folder("bash");
    let bin = folder.join("bin");
    std::fs::create_dir(&bin).unwrap();
    for (tool, code) in [("claude", 0), ("codex", 4)] {
        let fake = bin.join(tool);
        std::fs::write(&fake, format!("#!/bin/sh\necho \"{tool}-args: $*\"\nexit {code}\n")).unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let integration = tc_pty::integration::prepare(
        &folder.join("integration"),
        dunce::simplified(Path::new(HOOK)),
        Platform::current(),
        "/bin/bash",
    )
    .unwrap()
    .unwrap();
    let script = format!(
        "{}\nclaude\nclaude --resume {ID} --name 'name with spaces'\ncodex resume {ID}\necho codex-exit=$?\n",
        integration.command.clone().unwrap()
    );
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default());
    let output = Command::new(bash)
        .args(["--noprofile", "--norc", "-c", &script])
        .current_dir(&folder)
        .envs(integration.env.iter().cloned())
        .env("PATH", path)
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "{stdout}{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let (launches, ends) = launches(&output.stdout, Platform::current());
    assert_eq!(launches.len(), 3, "{stdout}");
    assert_eq!(launches[0]["provider"], "claude");
    let generated = launches[0]["sessionId"].as_str().unwrap();
    assert!(
        tc_core::session::is_session_id(generated),
        "a bare `claude` gets a new session ID"
    );
    assert!(
        stdout.contains(&format!("claude-args: --session-id {generated} --settings ")),
        "{stdout}"
    );
    assert_eq!(launches[1]["sessionId"], ID);
    assert!(
        stdout.contains(&format!(
            "claude-args: --resume {ID} --name name with spaces --settings "
        )),
        "{stdout}"
    );
    assert_eq!(
        (launches[2]["provider"].as_str(), launches[2]["sessionId"].as_str()),
        (Some("codex"), Some(ID))
    );
    assert!(
        launches
            .iter()
            .all(|launch| dunce::canonicalize(launch["cwd"].as_str().unwrap()).unwrap() == folder)
    );
    let codes: Vec<&Value> = ends.iter().map(|end| &end["exitCode"]).collect();
    assert_eq!(codes, [&json!(0), &json!(0), &json!(4)]);
    assert!(
        stdout.contains("codex-exit=4"),
        "the wrapper keeps the tool's exit status"
    );
    integration.cleanup();
    std::fs::remove_dir_all(folder).unwrap();
}

#[cfg(unix)]
#[test]
fn the_claude_hook_command_records_the_session() {
    let folder = temp_folder("claude-hook");
    let integration = tc_pty::integration::prepare(
        &folder.join("integration"),
        dunce::simplified(Path::new(HOOK)),
        Platform::current(),
        "/bin/bash",
    )
    .unwrap()
    .unwrap();
    let settings = std::fs::read_dir(folder.join("integration"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.to_string_lossy().ends_with(".settings.json"))
        .unwrap();
    let settings: Value = serde_json::from_str(&std::fs::read_to_string(settings).unwrap()).unwrap();
    let command = settings["hooks"]["SessionStart"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap();
    let cwd = folder.join("ไทย").join("工作").join("🚀");
    let input =
        json!({ "hook_event_name": "SessionStart", "session_id": ID, "cwd": cwd, "transcript_path": "/private" });
    let mut child = Command::new("/bin/sh")
        .args(["-c", command])
        .envs(integration.env.iter().cloned())
        .env("TC_LAUNCH_TOKEN", ID)
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes())
        .unwrap();
    assert!(child.wait().unwrap().success());
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(&integration.session_file).unwrap()).unwrap();
    assert_eq!(
        saved,
        json!({ "provider": "claude", "sessionId": ID, "cwd": cwd, "token": ID })
    );
    integration.cleanup();
    std::fs::remove_dir_all(folder).unwrap();
}

#[cfg(windows)]
mod windows {
    use super::*;

    fn powershell(
        executable: &str,
        script: &str,
        envs: &[(String, String)],
        path: Option<&Path>,
    ) -> Option<std::process::Output> {
        let mut command = Command::new(executable);
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            &tc_pty::shell::encode_command(script),
        ]);
        command.envs(envs.iter().cloned());
        if let Some(path) = path {
            command.env(
                "PATH",
                format!("{};{}", path.display(), std::env::var("PATH").unwrap_or_default()),
            );
        }
        match command.output() {
            Ok(output) => Some(output),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && executable == "pwsh.exe" => None,
            Err(error) => panic!("{executable}: {error}"),
        }
    }

    /// From `real Windows PowerShell wrappers detect manual Claude launches and pass arguments safely`.
    #[test]
    fn powershell_wrappers_report_manual_launches() {
        let folder = temp_folder("powershell");
        std::fs::write(folder.join("claude.cmd"), "@echo off\r\necho %*\r\nexit /b 0\r\n").unwrap();
        let settings = folder.join("settings with ' quote.json");
        let fake = tc_pty::shell::ps_quote(&folder.join("claude.cmd").to_string_lossy());
        let source = format!(
            "$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\nif ((Get-Command claude -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source -ine {fake}) {{ throw 'The controlled Claude stand-in did not resolve.' }}\n{}\nclaude\nclaude --resume {ID} --name 'name with spaces'\nprompt\n",
            tc_pty::shell::powershell_source(&settings.to_string_lossy())
        );
        let output = powershell("powershell.exe", &source, &[], Some(&folder)).unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success(),
            "{stdout}{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let (launches, _) = launches(&output.stdout, Platform::Windows);
        assert_eq!(launches.len(), 2, "{stdout}");
        assert!(tc_core::session::is_session_id(
            launches[0]["sessionId"].as_str().unwrap()
        ));
        assert_eq!(launches[1]["sessionId"], ID);
        assert!(
            stdout.contains("name with spaces"),
            "{stdout}{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            stdout.contains("settings with"),
            "{stdout}{}",
            String::from_utf8_lossy(&output.stderr)
        );
        std::fs::remove_dir_all(folder).unwrap();
    }

    /// From `the Windows Claude hook decodes Unicode directories as UTF-8`.
    #[test]
    fn the_windows_claude_hook_decodes_unicode_directories() {
        let folder = temp_folder("utf8");
        let integration = tc_pty::integration::prepare(
            &folder.join("integration"),
            dunce::simplified(Path::new(HOOK)),
            Platform::Windows,
            "powershell.exe",
        )
        .unwrap()
        .unwrap();
        let settings = std::fs::read_dir(folder.join("integration"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| path.to_string_lossy().ends_with(".settings.json"))
            .unwrap();
        let settings: Value = serde_json::from_str(&std::fs::read_to_string(settings).unwrap()).unwrap();
        let command = settings["hooks"]["SessionStart"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .to_owned();
        let cwd = folder.join("ไทย").join("工作").join("🚀");
        std::fs::create_dir_all(&cwd).unwrap();
        let input = json!({ "hook_event_name": "SessionStart", "session_id": ID, "cwd": cwd });
        let mut child = Command::new("cmd.exe")
            .args(["/d", "/s", "/c", &command])
            .envs(integration.env.iter().cloned())
            .env("TC_LAUNCH_TOKEN", ID)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.to_string().as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let text = std::fs::read_to_string(&integration.session_file).unwrap_or_else(|error| {
            panic!(
                "Hook did not write {}: {error}; stdout={}; stderr={}",
                integration.session_file.display(),
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        });
        let saved: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            saved,
            json!({ "provider": "claude", "sessionId": ID, "cwd": cwd, "token": ID })
        );
        integration.cleanup();
        std::fs::remove_dir_all(folder).unwrap();
    }

    /// From `AI integration preserves strict-mode custom prompts and native exit codes`.
    #[test]
    fn the_ai_integration_keeps_strict_mode_prompts_and_exit_codes() {
        for executable in ["powershell.exe", "pwsh.exe"] {
            let source = format!(
                "Set-StrictMode -Version Latest\n$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\nRemove-Variable -Name LASTEXITCODE -Scope Global -ErrorAction Ignore\nfunction global:prompt {{ \"CUSTOM:$?>\" }}\n{}\nWrite-Error 'expected failure' -ErrorAction SilentlyContinue\n$result = prompt\nWrite-Output ('RESULT=' + $result + ';EXISTS=' + ($null -ne (Get-Variable LASTEXITCODE -Scope Global -ErrorAction Ignore)))\n$global:LASTEXITCODE = 37\nWrite-Error 'expected failure' -ErrorAction SilentlyContinue\n$result = prompt\nWrite-Output ('RESULT2=' + $result + ';LAST=' + $global:LASTEXITCODE)",
                tc_pty::shell::powershell_source("unused-settings.json")
            );
            let Some(output) = powershell(executable, &source, &[], None) else {
                continue;
            };
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert!(
                output.status.success(),
                "{executable}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(String::from_utf8_lossy(&output.stderr), "", "{executable}");
            assert!(
                stdout.contains("RESULT=CUSTOM:False>;EXISTS=False"),
                "{executable}: {stdout}"
            );
            assert!(
                stdout.contains("RESULT2=CUSTOM:False>;LAST=37"),
                "{executable}: {stdout}"
            );
        }
    }
}

#[test]
fn new_terminal_queues_a_validated_request_for_the_host() {
    use tc_core::launch::take_requests;
    let folder = temp_folder("new-terminal");
    let inbox = folder.join("inbox");
    std::fs::create_dir_all(&inbox).unwrap();
    let project = folder.join("project");
    std::fs::create_dir_all(&project).unwrap();
    let run = |args: &[&str]| {
        let mut command = hook(&["new-terminal"], &folder);
        command.args(args).env(tc_core::launch::ENV, &inbox);
        command.output().unwrap()
    };

    let outside = hook(&["new-terminal", "--no-wait"], &folder).output().unwrap();
    assert_eq!(outside.status.code(), Some(1), "no app has created its inbox");
    assert!(String::from_utf8_lossy(&outside.stderr).contains("start the app first"));
    assert_eq!(run(&["--bogus"]).status.code(), Some(1));
    assert_eq!(run(&["--title"]).status.code(), Some(1));
    assert_eq!(run(&["--profile", "vim", "--no-wait"]).status.code(), Some(2));
    assert_eq!(run(&["--cwd", "missing", "--no-wait"]).status.code(), Some(2));
    assert_eq!(
        std::fs::read_dir(&inbox).unwrap().count(),
        0,
        "refused requests write nothing"
    );

    let queued = run(&[
        "--profile",
        "claude",
        "--title",
        "Handover",
        "--cwd",
        "project",
        "--command",
        "claude \"Read it\"",
        "--no-wait",
    ]);
    assert_eq!(
        queued.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&queued.stderr)
    );
    let taken = take_requests(&inbox, Platform::current());
    let request = taken[0].request.as_ref().unwrap();
    assert!(!request.reply, "--no-wait asks for no answer");
    assert_eq!(taken.len(), 1);
    assert_eq!(
        (
            request.title.as_str(),
            request.command.as_str(),
            request.profile.as_str()
        ),
        ("Handover", "claude \"Read it\"", "claude")
    );
    assert_eq!(
        Path::new(&request.cwd),
        project,
        "relative folders resolve from the current directory"
    );

    // A stand-in for the app: takes one request and answers it, or leaves it unanswered.
    let app = |answer: Option<Value>| {
        let inbox = inbox.clone();
        std::thread::spawn(move || {
            for _ in 0..50 {
                std::thread::sleep(std::time::Duration::from_millis(100));
                if let Some(taken) = take_requests(&inbox, Platform::current()).pop() {
                    let id = taken.id.unwrap();
                    assert!(taken.request.unwrap().reply);
                    if let Some(answer) = &answer {
                        tc_core::launch::write_result(&inbox, &id, answer);
                    }
                    return Some(id);
                }
            }
            None
        })
    };
    let host = app(Some(json!({ "status": "opened", "card": "card-7", "log": "ignored" })));
    let opened = run(&["--command", "ls", "--log"]);
    let id = host.join().unwrap().unwrap();
    assert_eq!(
        opened.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&opened.stderr)
    );
    let stdout = String::from_utf8_lossy(&opened.stdout);
    assert!(
        stdout.contains("opened a new terminal: Terminal (card card-7)"),
        "{stdout}"
    );
    let log = tc_core::launch::log_path(&inbox, &id);
    assert!(stdout.contains(&format!("Output log: {}", log.display())), "{stdout}");
    assert!(
        !tc_core::launch::result_path(&inbox, &id).exists(),
        "the answer is consumed"
    );

    // Opening can still fail after the app took the request, for example if its folder disappeared.
    let host = app(Some(
        json!({ "status": "failed", "error": "Working directory is unavailable." }),
    ));
    let failed = run(&["--json"]);
    host.join().unwrap().unwrap();
    assert_eq!(failed.status.code(), Some(2));
    let report: Value = serde_json::from_slice(&failed.stdout).unwrap();
    assert_eq!(report["status"], "failed");
    assert!(
        report["error"]
            .as_str()
            .unwrap()
            .contains("Working directory is unavailable.")
    );

    // Taken but never answered: the caller learns a terminal may still open.
    let host = app(None);
    let unconfirmed = run(&["--timeout", "2", "--json"]);
    host.join().unwrap().unwrap();
    assert_eq!(unconfirmed.status.code(), Some(4));
    assert_eq!(
        serde_json::from_slice::<Value>(&unconfirmed.stdout).unwrap()["status"],
        "unconfirmed"
    );

    // Without a host, the request is withdrawn so it cannot open a terminal later.
    let unanswered = run(&["--timeout", "1"]);
    assert_eq!(unanswered.status.code(), Some(3));
    assert_eq!(std::fs::read_dir(&inbox).unwrap().count(), 0);
    let _ = std::fs::remove_dir_all(folder);
}

#[test]
fn new_terminal_outside_a_terminal_asks_the_app_and_reports_json() {
    use tc_core::launch::{app_inbox, take_requests};
    let folder = temp_folder("new-terminal-app");
    let data = folder.join("app data");
    let inbox = app_inbox(&data);
    std::fs::create_dir_all(&inbox).unwrap();
    let card_inbox = folder.join("card inbox");
    std::fs::create_dir_all(&card_inbox).unwrap();
    let run = |args: &[&str], envs: &[(&str, &Path)]| {
        let mut command = hook(&["new-terminal"], &folder);
        command.args(args).env(tc_core::launch::DATA_ENV, &data);
        for (name, value) in envs {
            command.env(name, value);
        }
        command.output().unwrap()
    };
    let json = |output: &std::process::Output| -> Value { serde_json::from_slice(&output.stdout).unwrap() };

    // Outside any terminal, the app inbox takes the request; a parent may be named.
    let queued = run(
        &["--profile", "gemini", "--parent", "card-1", "--no-wait", "--json"],
        &[],
    );
    assert_eq!(queued.status.code(), Some(0));
    let report = json(&queued);
    assert_eq!(
        (report["status"].as_str(), report["via"].as_str()),
        (Some("queued"), Some("app"))
    );
    assert_eq!(report["request"]["command"], "gemini");
    let taken = take_requests(&inbox, Platform::current());
    assert_eq!(taken[0].request.as_ref().unwrap().parent.as_deref(), Some("card-1"));
    assert_eq!(report["request"]["parent"], "card-1");
    assert!(
        report.get("parent").is_none(),
        "until the app answers, the parent it will use is unknown"
    );

    // Once it answers, the report names the parent the app actually used, if any.
    let answered = |answer: Value, args: &[&str]| {
        let inbox = inbox.clone();
        let host = std::thread::spawn(move || {
            for _ in 0..50 {
                std::thread::sleep(std::time::Duration::from_millis(100));
                if let Some(taken) = take_requests(&inbox, Platform::current()).pop() {
                    tc_core::launch::write_result(&inbox, &taken.id.unwrap(), &answer);
                    return;
                }
            }
        });
        let output = run(args, &[]);
        host.join().unwrap();
        assert_eq!(
            output.status.code(),
            Some(0),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        json(&output)
    };
    let beside = answered(
        json!({ "status": "opened", "card": "card-2", "parent": "card-1" }),
        &["--parent", "card-1", "--json"],
    );
    assert_eq!(
        (beside["card"].as_str(), beside["parent"].as_str()),
        (Some("card-2"), Some("card-1"))
    );
    let orphan = answered(
        json!({ "status": "opened", "card": "card-3" }),
        &["--parent", "closed-card", "--json"],
    );
    assert_eq!(orphan["request"]["parent"], "closed-card");
    assert!(
        orphan.get("parent").is_none(),
        "a parent that no longer exists is not reported as used: {orphan}"
    );
    assert_eq!(report["id"], taken[0].id.clone().unwrap());

    // With --no-wait --log, the log path is known before the app answers.
    let logged = run(&["--no-wait", "--log", "--json"], &[]);
    let report = json(&logged);
    let id = report["id"].as_str().unwrap();
    assert_eq!(
        report["log"],
        tc_core::launch::log_path(&inbox, id).to_string_lossy().as_ref()
    );
    assert!(
        take_requests(&inbox, Platform::current())[0]
            .request
            .as_ref()
            .unwrap()
            .log
    );

    // Inside a terminal its own inbox wins, unless a parent or data folder is named.
    let own = run(&["--no-wait"], &[(tc_core::launch::ENV, &card_inbox)]);
    assert_eq!(own.status.code(), Some(0));
    assert_eq!(take_requests(&card_inbox, Platform::current()).len(), 1);
    let named = run(
        &["--no-wait", "--parent", "other"],
        &[(tc_core::launch::ENV, &card_inbox)],
    );
    assert_eq!(named.status.code(), Some(0));
    assert_eq!(take_requests(&inbox, Platform::current()).len(), 1);

    let refused = run(&["--parent", "../bad", "--json"], &[]);
    assert_eq!(refused.status.code(), Some(2));
    assert_eq!(json(&refused)["status"], "refused");
    let timeout = run(&["--timeout", "1", "--json"], &[]);
    assert_eq!(timeout.status.code(), Some(3));
    assert_eq!(json(&timeout)["status"], "timeout");
    assert_eq!(
        std::fs::read_dir(&inbox).unwrap().count(),
        0,
        "a timed-out request is withdrawn"
    );
    let missing = run(&["--data-dir", "nowhere", "--json"], &[]);
    assert_eq!(missing.status.code(), Some(1));
    assert_eq!(json(&missing)["status"], "unavailable");
    let _ = std::fs::remove_dir_all(folder);
}
