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
    folder.canonicalize().unwrap()
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
        .env_remove("TC_SESSION_FILE");
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
            let same = Path::new(cwd).canonicalize().ok() == Some(folder.clone());
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
        Path::new(HOOK),
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
            .all(|launch| Path::new(launch["cwd"].as_str().unwrap()).canonicalize().unwrap() == folder)
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
        Path::new(HOOK),
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
        let source = tc_pty::shell::powershell_source(&settings.to_string_lossy())
            + &format!("\nclaude\nclaude --resume {ID} --name 'name with spaces'\nprompt\n");
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
        assert!(stdout.contains("name with spaces"), "{stdout}");
        assert!(stdout.contains("settings with"), "{stdout}");
        std::fs::remove_dir_all(folder).unwrap();
    }

    /// From `the Windows Claude hook decodes Unicode directories as UTF-8`.
    #[test]
    fn the_windows_claude_hook_decodes_unicode_directories() {
        let folder = temp_folder("utf8");
        let integration = tc_pty::integration::prepare(
            &folder.join("integration"),
            Path::new(HOOK),
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
