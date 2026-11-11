//! `tc-hook`, the sidecar the shell integration runs, from `src/session-hook.cjs`.
//!
//! ```text
//! tc-hook record <provider>                  Claude's SessionStart hook: read the hook input on stdin
//!                                            and record the session for the host
//! tc-hook emit launch <provider> <session>   report an AI CLI launch to the host (OSC 633)
//! tc-hook emit end <exit code>               report that it ended
//! ```
//!
//! CLI hook input can contain private fields; only recovery metadata is kept. A hook never blocks
//! the agent, so `record` always exits successfully.

use std::env;
use std::io::{self, Read, Write};
use std::path::Path;
use std::process::ExitCode;

use base64::Engine;
use serde_json::{Map, Value};
use tc_core::atomic::{self, Access};
use tc_core::js::{is_js_whitespace, utf16_len};
use tc_core::session::{is_session_id, session_metadata};

/// The most hook input read, in UTF-16 units as the JavaScript hook counted it.
const INPUT_UNITS: usize = 65536;
const UTF8_PREAMBLE: &[u8] = b"\xef\xbb\xbf";

fn main() -> ExitCode {
    let args: Vec<String> = env::args_os()
        .skip(1)
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    let arg = |index: usize| args.get(index).map(String::as_str);
    match arg(0) {
        Some("emit") => emit(arg(1), arg(2), arg(3)),
        Some("record") if arg(1).is_some() => {
            let _ = record(arg(1).unwrap_or_default());
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("usage: tc-hook record <provider> | emit launch <provider> <session> | emit end <exit code>");
            ExitCode::from(2)
        }
    }
}

fn token() -> Option<String> {
    env::var("TC_LAUNCH_TOKEN").ok()
}

/// Writes `\x1b]633;TC;<base64 JSON>\x07`. Absent values are left out, as `JSON.stringify` drops
/// `undefined`.
fn emit(kind: Option<&str>, first: Option<&str>, second: Option<&str>) -> ExitCode {
    let mut event = Map::new();
    if let Some(kind) = kind {
        event.insert("type".into(), kind.into());
    }
    if kind == Some("launch") {
        if let Some(provider) = first {
            event.insert("provider".into(), provider.into());
        }
        if let Some(session) = second {
            event.insert("sessionId".into(), session.into());
        }
        let Ok(cwd) = env::current_dir() else {
            return ExitCode::FAILURE;
        };
        event.insert("cwd".into(), cwd.to_string_lossy().into_owned().into());
    } else {
        event.insert("exitCode".into(), js_number(first.unwrap_or("undefined")));
    }
    if let Some(token) = token() {
        event.insert("token".into(), token.into());
    }
    let json = Value::Object(event).to_string();
    let report = format!(
        "\x1b]633;TC;{}\x07",
        base64::engine::general_purpose::STANDARD.encode(json)
    );
    let mut stdout = io::stdout().lock();
    match stdout.write_all(report.as_bytes()).and_then(|()| stdout.flush()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => ExitCode::FAILURE,
    }
}

/// `Number(text)` as JSON: whole numbers as integers, and `NaN` or infinities as `null`.
fn js_number(text: &str) -> Value {
    let text = text.trim_matches(is_js_whitespace);
    let value = if text.is_empty() {
        Some(0.0)
    } else if let Some(digits) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        radix(digits, 16)
    } else if let Some(digits) = text.strip_prefix("0o").or_else(|| text.strip_prefix("0O")) {
        radix(digits, 8)
    } else if let Some(digits) = text.strip_prefix("0b").or_else(|| text.strip_prefix("0B")) {
        radix(digits, 2)
    } else if decimal_literal(text) {
        text.parse::<f64>().ok()
    } else {
        None
    };
    match value.filter(|value| value.is_finite()) {
        Some(value) if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 => Value::from(value as i64),
        Some(value) => Value::from(value),
        None => Value::Null,
    }
}

fn radix(digits: &str, radix: u32) -> Option<f64> {
    if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
        return None;
    }
    Some(digits.chars().fold(0.0, |value, c| {
        value * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
    }))
}

/// `StrDecimalLiteral`: an optional sign, digits with an optional fraction, and an optional exponent.
fn decimal_literal(text: &str) -> bool {
    let body = text.strip_prefix(['+', '-']).unwrap_or(text);
    if body == "Infinity" {
        return true;
    }
    let (mantissa, exponent) = match body.find(['e', 'E']) {
        Some(index) => (&body[..index], Some(&body[index + 1..])),
        None => (body, None),
    };
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = |part: &str| part.bytes().all(|b| b.is_ascii_digit());
    let mantissa_ok = digits(whole) && digits(fraction) && !(whole.is_empty() && fraction.is_empty());
    let exponent_ok = exponent.is_none_or(|exponent| {
        let exponent = exponent.strip_prefix(['+', '-']).unwrap_or(exponent);
        !exponent.is_empty() && digits(exponent)
    });
    mantissa_ok && exponent_ok
}

/// Reads the hook input and writes the session file. Returns whether a session was recorded.
fn record(provider: &str) -> bool {
    let mut input = Vec::new();
    // PowerShell's native pipeline may add a UTF-8 encoding signature.
    // Allow its three transport bytes in addition to the UTF-16 document limit.
    let limit = INPUT_UNITS * 3 + UTF8_PREAMBLE.len() + 1;
    if io::stdin().lock().take(limit as u64).read_to_end(&mut input).is_err() || input.len() >= limit {
        return false;
    }
    let input = input.strip_prefix(UTF8_PREAMBLE).unwrap_or(&input);
    let text = String::from_utf8_lossy(input);
    if utf16_len(&text) > INPUT_UNITS {
        return false;
    }
    let Ok(input) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    let (Some(file), Some(token)) = (env::var_os("TC_SESSION_FILE"), token()) else {
        return false;
    };
    record_session(&input, provider, Path::new(&file), &token)
}

fn record_session(input: &Value, provider: &str, file: &Path, token: &str) -> bool {
    let field = |key| input.get(key).cloned().unwrap_or(Value::Null);
    let raw = serde_json::json!({ "provider": provider, "sessionId": field("session_id"), "cwd": field("cwd") });
    let Some(session) = session_metadata(&raw) else {
        return false;
    };
    if input.get("hook_event_name").and_then(Value::as_str) != Some("SessionStart")
        || !is_session_id(token)
        || file.as_os_str().is_empty()
    {
        return false;
    }
    let mut saved = serde_json::to_value(&session).expect("sessions serialize");
    saved["token"] = token.into();
    atomic::write(file, saved.to_string().as_bytes(), Access::Private).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_codes_parse_like_number() {
        let cases = [
            ("0", "0"),
            ("127", "127"),
            ("", "0"),
            ("  12\n", "12"),
            ("abc", "null"),
            ("0x1f", "31"),
            ("1e3", "1000"),
            ("-1", "-1"),
            ("Infinity", "null"),
            ("undefined", "null"),
            ("1.5", "1.5"),
            (".5", "0.5"),
            ("5.", "5"),
            ("+3", "3"),
            ("1e", "null"),
            ("0b101", "5"),
            ("-0x1", "null"),
            ("inf", "null"),
            ("NaN", "null"),
        ];
        for (text, expected) in cases {
            assert_eq!(js_number(text).to_string(), expected, "{text:?}");
        }
    }
}
