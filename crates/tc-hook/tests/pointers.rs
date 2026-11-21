use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Duration;

use serde_json::{Value, json};
use tc_core::pointers;

const HOOK: &str = env!("CARGO_BIN_EXE_tc-hook");

fn roundtrip(args: &[&str], input: &Value, answer: Value) -> (std::process::Output, pointers::Report) {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let inbox = std::env::temp_dir().join(format!("tc-hook-pointer-{}-{nonce}", std::process::id()));
    tc_core::launch::create_inbox(&inbox, true).unwrap();
    let folder = inbox.clone();
    let host = std::thread::spawn(move || {
        for _ in 0..200 {
            if let Some((id, report)) = pointers::take(&folder).into_iter().next() {
                pointers::answer(&folder, &id, &answer).unwrap();
                return report;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("No request from tc-hook");
    });
    let mut child = Command::new(HOOK)
        .args(args)
        .env("TC_LAUNCH_DIR", &inbox)
        .env("TC_LAUNCH_TOKEN", "abcdef01-1234-4321-9876-123456789abc")
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
    let report = host.join().unwrap();
    std::fs::remove_dir_all(inbox).unwrap();
    (output, report)
}

#[test]
fn captured_agent_triggers_use_the_private_inbox_and_return_failures() {
    let (output, report) = roundtrip(
        &["trigger", "reviewed"],
        &json!(null),
        json!({"matched":2,"failed":1,"error":"Target is closed."}),
    );
    assert!(!output.status.success());
    assert_eq!(report.kind, "trigger");
    assert_eq!(report.name, "reviewed");
    assert!(String::from_utf8(output.stdout).unwrap().contains("Target is closed."));
    assert!(report.message.is_empty());
}

#[test]
fn stop_returns_the_host_continuation_and_keeps_only_a_bounded_message_excerpt() {
    for provider in ["claude", "codex"] {
        let (output, report) = roundtrip(
            &["lifecycle", provider],
            &json!({
                "hook_event_name":"Stop", "session_id":"12345678-1234-4321-9876-123456789abc",
                "last_assistant_message":format!("\u{1b}{}", "😀".repeat(600)), "stop_hook_active":true,
                "transcript_path":"NEVER_KEEP", "prompt":"NEVER_KEEP"
            }),
            json!({"decision":"block","reason":"Review next"}),
        );
        assert!(output.status.success());
        assert_eq!(report.kind, "stop");
        assert_eq!(report.provider, provider);
        assert!(report.stop_hook_active);
        assert_eq!(report.message, "😀".repeat(500));
        assert!(!serde_json::to_string(&report).unwrap().contains("NEVER_KEEP"));
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stdout).unwrap(),
            json!({"decision":"block","reason":"Review next"})
        );
    }
}

#[test]
fn unsupported_hooks_fail_open_and_invalid_explicit_triggers_fail_closed() {
    let mut child = Command::new(HOOK)
        .args(["lifecycle", "claude"])
        .env_remove("TC_LAUNCH_DIR")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(br#"{"hook_event_name":"unknown"}"#)
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    let output = Command::new(HOOK).args(["trigger", "../bad"]).output().unwrap();
    assert!(!output.status.success());
}
