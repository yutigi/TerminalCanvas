//! Private request/response transport, also usable from an agent's captured shell tool.
use std::env;
use std::io::{self, Read};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tc_core::pointers::{self, Report};

pub fn run(args: &[String], lifecycle: bool) -> ExitCode {
    let result = if lifecycle { from_stdin(args) } else { explicit(args) }.and_then(send);
    match result {
        Ok(answer) => {
            if lifecycle {
                if answer.get("decision").and_then(Value::as_str) == Some("block") {
                    println!("{answer}");
                }
            } else {
                println!("{answer}");
                if answer.get("error").is_some() {
                    return ExitCode::FAILURE;
                }
            }
            ExitCode::SUCCESS
        }
        // A lifecycle hook must never block or break an agent on transport failure.
        Err(error) if lifecycle => {
            eprintln!("Terminal Canvas hook: {error}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("tc-hook trigger: {error}");
            ExitCode::FAILURE
        }
    }
}

fn base(kind: &str) -> Report {
    Report {
        kind: kind.into(),
        token: env::var("TC_LAUNCH_TOKEN").unwrap_or_default(),
        provider: String::new(),
        session_id: String::new(),
        message: String::new(),
        name: String::new(),
        exit_code: None,
        stop_hook_active: false,
        expires: pointers::now_ms() + 2000,
    }
}

fn explicit(args: &[String]) -> Result<Report, String> {
    if args.len() > 1 || args.first().is_some_and(|name| !pointers::valid_name(name)) {
        return Err("usage: tc-hook trigger [name] (name: up to 64 letters, digits, - or _)".into());
    }
    let mut report = base("trigger");
    report.name = args.first().cloned().unwrap_or_default();
    Ok(report)
}

fn from_stdin(args: &[String]) -> Result<Report, String> {
    if args.len() != 1 || !matches!(args[0].as_str(), "claude" | "codex") {
        return Err("Unknown hook provider.".into());
    }
    let mut bytes = Vec::new();
    io::stdin()
        .lock()
        .take(196613)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes);
    if bytes.len() > 196608 {
        return Err("Hook input is too large.".into());
    }
    let input: Value = serde_json::from_slice(bytes).map_err(|_| "Invalid hook input.")?;
    let kind = match input["hook_event_name"].as_str() {
        Some("Stop") => "stop",
        Some("UserPromptSubmit") => "busy",
        Some("StopFailure") => "failed",
        Some("Interrupt") => "interrupt",
        Some("SessionEnd") => "session-end",
        _ => return Err("Unsupported hook event.".into()),
    };
    let mut report = base(kind);
    report.provider.clone_from(&args[0]);
    report.session_id = input["session_id"].as_str().unwrap_or_default().to_owned();
    report.stop_hook_active = input["stop_hook_active"].as_bool().unwrap_or(false);
    let mut units = 0;
    report.message = input["last_assistant_message"]
        .as_str()
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .take_while(|c| {
            units += c.len_utf16();
            units <= pointers::MESSAGE_UNITS
        })
        .collect();
    if !report.valid() || report.session_id.is_empty() {
        return Err("Invalid lifecycle metadata.".into());
    }
    Ok(report)
}

fn send(report: Report) -> Result<Value, String> {
    let inbox = env::var_os(tc_core::launch::ENV)
        .map(PathBuf::from)
        .ok_or("Run inside an integrated Terminal Canvas terminal.")?;
    let (id, file) = pointers::write_request(&inbox, &report).map_err(|e| e.to_string())?;
    let answer = pointers::answer_path(&inbox, &id);
    let deadline = Instant::now() + Duration::from_millis(2500);
    while Instant::now() < deadline {
        if let Ok(bytes) = std::fs::read(&answer) {
            let _ = std::fs::remove_file(&answer);
            return serde_json::from_slice(&bytes).map_err(|_| "Invalid host response.".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    // Withdrawing is atomic against the host's claim; a claimed trigger may already have fired.
    let withdrawn = file.with_extension("hook-withdrawn");
    if std::fs::rename(&file, &withdrawn).is_ok() {
        let _ = std::fs::remove_file(withdrawn);
    }
    Err(json!({"error":"Host did not answer within 2.5 seconds; check the canvas before retrying."}).to_string())
}
