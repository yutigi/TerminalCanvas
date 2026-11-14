//! `tc-hook new-terminal`: ask the running Terminal Canvas app for a new terminal.
//!
//! Any program can use it: an AI agent of any kind, a harness, a script, or a person. Inside a
//! Terminal Canvas terminal the request goes to that terminal's inbox (`TC_LAUNCH_DIR`), and the
//! new card opens beside it, joined to it by an arrow. Anywhere else, or with `--parent`, the
//! request goes to the app's inbox in its data folder; the card then opens beside the named parent
//! card, or in view on its own. See `tc_core::launch`.
//!
//! Unless `--no-wait` is given, it waits for the app's answer and reports the new card's ID, or why
//! nothing opened. With `--log`, the app writes the new terminal's output as plain text to a file
//! whose path is reported, ending with a line naming the exit code when the process ends.
//!
//! Exit codes: 0 opened (or queued with `--no-wait`), 1 usage error or no running app to ask,
//! 2 refused or failed to open, 3 not taken in time (withdrawn, nothing opens), 4 taken but the app
//! did not answer in time (a terminal may still open).
//!
//! Every failure says what to do next. Once the request is valid, a failure also reports it, so the
//! caller can tell the user which folder and command to open by hand. When a terminal may still
//! open (`unconfirmed`), that advice waits until the user has checked the canvas.

use std::env;
use std::io;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};
use tc_core::launch::{self, LaunchRequest, log_path, result_path, validate_request, write_request};

pub const USAGE: &str = "\
usage: tc-hook new-terminal [--profile <shell|claude|codex|gemini|custom>] [--title <title>]
                            [--cwd <folder>] [--command <command>] [--parent <card id>]
                            [--data-dir <folder>] [--log] [--timeout <seconds>] [--no-wait] [--json]

Opens a new terminal on the Terminal Canvas board and starts it. The command is typed into the new
terminal's shell; without one, the profile's command runs (none for shell). The folder defaults to
the current directory; relative folders resolve from it.

Run inside a Terminal Canvas terminal, the new card opens beside that terminal, joined to it by an
arrow. Run anywhere else, it asks the running app through its data folder (TERMINAL_CANVAS_DATA or
--data-dir override the default) and opens in view, or beside --parent (a card's TC_CARD_ID).

It waits for the app's answer and prints the new card's ID. --log asks the app to write the new
terminal's output as plain text to a file (its path is printed); the file ends with
\"[Terminal Canvas: the process exited with code N]\" when the process ends. Read it to follow the
new terminal. The log lives in the request folder: for a terminal's own requests, it is removed
when that terminal ends.

--json prints one JSON object whose \"status\" is opened, queued, refused, failed, timeout,
unconfirmed, unavailable, or usage. Exit codes: 0 opened/queued, 1 usage/unavailable,
2 refused/failed, 3 timeout (nothing opens), 4 unconfirmed (the app took the request but did not
answer in time; a terminal may still open). A failure says what to do next and, once the request
is valid, names the folder and command to open by hand (\"request\" with --json); for unconfirmed,
only after checking the canvas.";

/// How long to wait for the app to take a request by default.
const WAIT: Duration = Duration::from_secs(10);

/// The inbox a request went to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Via {
    /// The requesting terminal's own inbox, `TC_LAUNCH_DIR`.
    Terminal,
    /// The app's inbox in its data folder.
    App,
}

impl Via {
    fn as_str(self) -> &'static str {
        match self {
            Via::Terminal => "terminal",
            Via::App => "app",
        }
    }
}

struct Output {
    json: bool,
    /// The validated request, so a failure can say how to open it by hand.
    request: Option<LaunchRequest>,
    /// The request's ID and inbox, once it has been written.
    sent: Option<(String, Via)>,
    /// Where the new terminal's output goes, when `--log` asked for it.
    log: Option<PathBuf>,
}

impl Output {
    /// A JSON report with `status` and what is known about the request so far. The log path is
    /// only worth following when a terminal opened or may still open.
    fn report(&self, status: &str, may_open: bool) -> Value {
        let mut report = json!({ "status": status });
        if let Some((id, via)) = &self.sent {
            report["id"] = id.as_str().into();
            report["via"] = via.as_str().into();
        }
        if let Some(request) = &self.request {
            report["request"] = json!(request);
        }
        if let Some(log) = self.log.as_ref().filter(|_| may_open) {
            report["log"] = log.to_string_lossy().into_owned().into();
        }
        report
    }

    /// Reports a failure after which no terminal opens, on stderr or as a JSON status on stdout.
    /// Once the request is valid, the report includes it; as text, that is the folder and command to
    /// open by hand.
    fn fail(&self, code: u8, status: &str, message: &str) -> ExitCode {
        if self.json {
            let mut report = self.report(status, false);
            report["error"] = message.into();
            println!("{report}");
        } else {
            eprintln!("tc-hook new-terminal: {message}");
            if let Some(request) = &self.request {
                eprintln!("To open it yourself, {}", by_hand(request));
            }
        }
        ExitCode::from(code)
    }

    /// Reports that the app took the request but its outcome is unknown, so a terminal may still
    /// open. The report keeps the log such a terminal writes to, and opening the terminal by hand
    /// waits until the user has checked the canvas, so it never opens twice.
    fn unconfirmed(&self, message: &str) -> ExitCode {
        if self.json {
            let mut report = self.report("unconfirmed", true);
            report["error"] = message.into();
            println!("{report}");
        } else {
            eprintln!("tc-hook new-terminal: {message}");
            if let Some(log) = &self.log {
                eprintln!("If it opens, its output goes to {}", log.display());
            }
            if let Some(request) = &self.request {
                eprintln!(
                    "If no new terminal appears on the canvas, open it yourself: {}",
                    by_hand(request)
                );
            }
        }
        ExitCode::from(4)
    }

    /// Reports success. `extra` holds the card ID, the parent it opened beside, and any warning from
    /// the app, when known.
    fn done(&self, status: &str, extra: Map<String, Value>, message: &str) -> ExitCode {
        if self.json {
            let mut report = self.report(status, true);
            for (key, value) in extra {
                report[key] = value;
            }
            println!("{report}");
        } else {
            println!("{message}");
        }
        ExitCode::SUCCESS
    }
}

/// How to open the requested terminal without Terminal Canvas, such as "start a terminal in /repo
/// and run: npm test".
fn by_hand(request: &LaunchRequest) -> String {
    match request.command.as_str() {
        "" => format!("start a terminal in {}.", request.cwd),
        command => format!("start a terminal in {} and run: {command}", request.cwd),
    }
}

/// `wait` for a message, such as "10 seconds".
fn seconds(wait: Duration) -> String {
    let seconds = wait.as_secs_f64();
    if seconds == 1.0 {
        "1 second".to_owned()
    } else {
        format!("{seconds} seconds")
    }
}

/// Why a request could not be written to `inbox`, and what to do about it.
fn unwritable(inbox: &Path, via: Via, error: &io::Error) -> String {
    // A sandbox with a private temporary folder cannot see the folder either, and is the likelier
    // cause while the terminal that set it still runs this command.
    let next = if error.kind() == io::ErrorKind::NotFound && via == Via::Terminal {
        "This terminal's request folder is not visible here: a sandbox may hide it (run this command outside the sandbox, or approve it), or the terminal that set TC_LAUNCH_DIR has ended (pass --parent with its TC_CARD_ID to ask the app instead)."
    } else {
        "If a sandbox blocks writes there, run this command outside the sandbox (approve it), or allow writes to that folder."
    };
    format!("could not write the request to {}: {error}. {next}", inbox.display())
}

pub fn run(args: &[String]) -> ExitCode {
    let mut fields = Map::new();
    let mut wait = Some(WAIT);
    let mut data_dir: Option<PathBuf> = None;
    let mut output = Output {
        json: false,
        request: None,
        sent: None,
        log: None,
    };
    let mut rest = args.iter();
    let usage = |output: &Output, message: &str| {
        if !output.json {
            eprintln!("tc-hook new-terminal: {message}\n\n{USAGE}");
            return ExitCode::from(1);
        }
        output.fail(1, "usage", message)
    };
    while let Some(flag) = rest.next() {
        let key = match flag.as_str() {
            "-h" | "--help" => {
                println!("{USAGE}");
                return ExitCode::SUCCESS;
            }
            "--no-wait" => {
                wait = None;
                continue;
            }
            "--json" => {
                output.json = true;
                continue;
            }
            "--log" => {
                fields.insert("log".into(), true.into());
                continue;
            }
            "--profile" | "--title" | "--cwd" | "--command" | "--parent" | "--data-dir" | "--timeout" => &flag[2..],
            _ => return usage(&output, &format!("unknown option {flag:?}")),
        };
        let Some(value) = rest.next() else {
            return usage(&output, &format!("{flag} needs a value"));
        };
        match key {
            "timeout" => match value.parse::<f64>() {
                Ok(seconds) if (1.0..=600.0).contains(&seconds) => {
                    wait = wait.map(|_| Duration::from_secs_f64(seconds));
                }
                _ => return usage(&output, "--timeout takes 1 to 600 seconds"),
            },
            "data-dir" => data_dir = Some(PathBuf::from(value)),
            _ => {
                fields.insert(key.to_owned(), value.clone().into());
            }
        }
    }
    let Ok(current) = env::current_dir() else {
        return output.fail(1, "unavailable", "the current directory is unavailable.");
    };
    let folder = fields
        .get("cwd")
        .and_then(Value::as_str)
        .map_or_else(|| current.clone(), |cwd| current.join(cwd));
    // `dunce` keeps Windows paths in the form shells accept, without the `\\?\` prefix.
    let folder = dunce::canonicalize(&folder).unwrap_or(folder);
    if !folder.is_dir() {
        return output.fail(2, "refused", &format!("{} is not a folder.", folder.display()));
    }
    fields.insert("cwd".into(), folder.to_string_lossy().into_owned().into());
    fields.insert("reply".into(), wait.is_some().into());
    let request = match validate_request(&Value::Object(fields), tc_core::Platform::current()) {
        Ok(request) => request,
        Err(error) => return output.fail(2, "refused", &error.to_string()),
    };
    output.request = Some(request.clone());
    // A terminal's own inbox always opens beside that terminal; naming a parent or a data folder
    // asks the app instead.
    let terminal_inbox = env::var_os(launch::ENV)
        .filter(|inbox| !inbox.is_empty())
        .map(PathBuf::from)
        .filter(|_| request.parent.is_none() && data_dir.is_none());
    let (inbox, via) = match terminal_inbox {
        Some(inbox) => (inbox, Via::Terminal),
        None => {
            let data = data_dir
                .or_else(|| {
                    env::var_os(launch::DATA_ENV)
                        .filter(|d| !d.is_empty())
                        .map(PathBuf::from)
                })
                .or_else(tc_core::dirs::app_data_dir);
            let Some(data) = data else {
                return output.fail(
                    1,
                    "unavailable",
                    "the Terminal Canvas data folder is unknown: pass --data-dir, or set TERMINAL_CANVAS_DATA.",
                );
            };
            let inbox = launch::app_inbox(&data);
            if !inbox.is_dir() {
                return output.fail(
                    1,
                    "unavailable",
                    &format!(
                        "Terminal Canvas is not set up for this user ({} does not exist): start the app first, or pass --data-dir with the data folder of the running app.",
                        inbox.display()
                    ),
                );
            }
            (inbox, Via::App)
        }
    };
    let (id, file) = match write_request(&inbox, &request) {
        Ok(written) => written,
        Err(error) => return output.fail(1, "unavailable", &unwritable(&inbox, via, &error)),
    };
    output.sent = Some((id.clone(), via));
    output.log = request.log.then(|| log_path(&inbox, &id));
    let mut extra = Map::new();
    let mut lines = Vec::new();
    if let Some(log) = &output.log {
        lines.push(format!("Output log: {}", log.display()));
    }
    // A terminal's own inbox always opens beside that terminal, or not at all. The app inbox only
    // knows which parent it used once it answers: a named card may have closed.
    let own_parent = || {
        (via == Via::Terminal)
            .then(|| env::var(launch::CARD_ENV).ok())
            .flatten()
    };
    let Some(wait) = wait else {
        if let Some(parent) = own_parent() {
            extra.insert("parent".into(), parent.into());
        }
        lines.insert(0, format!("Requested a new terminal: {}", request.title));
        return output.done("queued", extra, &lines.join("\n"));
    };
    let deadline = Instant::now() + wait;
    while file.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    // Withdraw a request the app has not taken, so it cannot open a terminal later. The app claims
    // a request the same way before reading it, so when both try at once, only one succeeds.
    if launch::withdraw_request(&file) {
        return output.fail(
            3,
            "timeout",
            &format!(
                "Terminal Canvas did not take the request within {}, so it was withdrawn and no terminal opens. Check that the app is running and responding, then retry; a longer --timeout gives a busy app more time.",
                seconds(wait)
            ),
        );
    }
    // The app answers once the terminal has started, or failed to; that gets the same time again.
    let answer_file = result_path(&inbox, &id);
    let answer_deadline = Instant::now() + wait;
    let answer = loop {
        if let Ok(text) = std::fs::read_to_string(&answer_file) {
            let _ = std::fs::remove_file(&answer_file);
            match serde_json::from_str::<Value>(&text) {
                Ok(answer) => break answer,
                Err(_) => {
                    return output.unconfirmed(
                        "Terminal Canvas answered, but its answer could not be read; a terminal may have opened. Check the canvas before opening one yourself.",
                    );
                }
            }
        }
        if !inbox.is_dir() {
            return output.unconfirmed(&format!(
                "the request folder {} disappeared before Terminal Canvas answered, usually because the terminal that asked has ended; a terminal may still open. Check the canvas before opening one yourself.",
                inbox.display()
            ));
        }
        if Instant::now() >= answer_deadline {
            return output.unconfirmed(&format!(
                "Terminal Canvas took the request but did not report the result within {}; a terminal may still open. Check the canvas before opening one yourself.",
                seconds(wait)
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let text = |key: &str| answer.get(key).and_then(Value::as_str);
    match (text("status"), text("card")) {
        (Some("opened"), Some(card)) => {
            // Older apps do not report the parent; for a terminal's own inbox it can only be that
            // terminal.
            let parent = text("parent").map(str::to_owned).or_else(own_parent);
            if let Some(parent) = parent {
                extra.insert("parent".into(), parent.into());
            }
            extra.insert("card".into(), card.into());
            lines.insert(
                0,
                format!("Terminal Canvas opened a new terminal: {} (card {card})", request.title),
            );
            // For example, the new terminal started without integration, so it cannot open more.
            if let Some(warning) = text("warning") {
                extra.insert("warning".into(), warning.into());
                lines.push(format!("Warning: {warning}"));
            }
            output.done("opened", extra, &lines.join("\n"))
        }
        (status, _) => {
            let status = if status == Some("refused") { "refused" } else { "failed" };
            let error = text("error").unwrap_or("The terminal could not be opened.");
            output.fail(
                2,
                status,
                &format!("Terminal Canvas did not open the terminal: {error}"),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failures_say_what_to_do_next() {
        let inbox = Path::new("inbox");
        let denied = io::Error::from(io::ErrorKind::PermissionDenied);
        for via in [Via::Terminal, Via::App] {
            assert!(
                unwritable(inbox, via, &denied).ends_with(
                    "If a sandbox blocks writes there, run this command outside the sandbox (approve it), or allow writes to that folder."
                ),
                "{via:?}"
            );
        }
        // A missing terminal folder: the terminal ended, or a sandbox has its own temporary folder.
        let gone = io::Error::from(io::ErrorKind::NotFound);
        let missing = unwritable(inbox, Via::Terminal, &gone);
        assert!(
            missing.contains("a sandbox may hide it (run this command outside the sandbox"),
            "{missing}"
        );
        assert!(missing.contains("pass --parent with its TC_CARD_ID"), "{missing}");
        assert!(unwritable(inbox, Via::App, &gone).contains("If a sandbox blocks writes there"));

        assert_eq!(seconds(Duration::from_secs(1)), "1 second");
        assert_eq!(seconds(Duration::from_secs(10)), "10 seconds");
        assert_eq!(seconds(Duration::from_millis(2500)), "2.5 seconds");

        let request = |command: &str| LaunchRequest {
            profile: tc_core::workspace::ProfileId::Shell,
            title: "Terminal".into(),
            cwd: "/repo".into(),
            command: command.into(),
            parent: None,
            reply: true,
            log: false,
        };
        assert_eq!(
            by_hand(&request("codex \"Read the handover\"")),
            "start a terminal in /repo and run: codex \"Read the handover\""
        );
        assert_eq!(by_hand(&request("")), "start a terminal in /repo.");
    }
}
