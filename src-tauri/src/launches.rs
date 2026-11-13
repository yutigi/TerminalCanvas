//! Bookkeeping for terminals that programs ask for (see `tc_core::launch`): requests waiting for the
//! UI to report what happened, and the output logs of the terminals they opened.
//!
//! The UI reports each outcome with `launch-result`, after the new terminal has started or failed.
//! Only requests the host took from an inbox can be answered, so the UI never names a file path.

use std::collections::{HashMap, VecDeque};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::mpsc;

use serde_json::{Value, json};
use tc_core::launch::{log_path, write_result};
use tc_core::plain::PlainText;

/// Requests remembered while waiting for the UI; the oldest are forgotten beyond this.
const PENDING_LIMIT: usize = 256;
/// The most output one log keeps, in bytes of plain text.
pub const LOG_BYTES: usize = 16 * 1024 * 1024;
/// Polls without output after which a log writes the row its decoder holds back (the host polls
/// every 500 ms), so a prompt waiting for input reaches the log while progress meters that rewrite
/// their row every second or so do not leave every step behind.
const IDLE_POLLS: u8 = 3;

/// A request the UI has been asked to open.
#[derive(Debug, Clone)]
pub struct Pending {
    pub inbox: PathBuf,
    /// The sender waits for an answer.
    pub reply: bool,
    /// The sender wants the new terminal's output logged.
    pub log: bool,
}

struct OutputLog {
    file: PathBuf,
    plain: PlainText,
    bytes: usize,
    /// Polls since the last output.
    quiet: u8,
}

enum Job {
    Create(PathBuf),
    Append(PathBuf, String),
}

pub struct Launches {
    pending: HashMap<String, Pending>,
    order: VecDeque<String>,
    logs: HashMap<String, OutputLog>,
    /// Log files are written on their own thread, in order, so the host never waits on them.
    jobs: mpsc::Sender<Job>,
}

impl Default for Launches {
    fn default() -> Self {
        Self::new()
    }
}

impl Launches {
    pub fn new() -> Self {
        let (jobs, queue) = mpsc::channel::<Job>();
        std::thread::Builder::new()
            .name("tc-output-logs".into())
            .spawn(move || {
                for job in queue {
                    // A log whose folder is gone (its requesting terminal ended) is skipped.
                    let _ = match job {
                        Job::Create(file) => private_options(true).open(file).map(drop),
                        Job::Append(file, text) => private_options(false)
                            .open(file)
                            .and_then(|mut file| file.write_all(text.as_bytes())),
                    };
                }
            })
            .expect("log thread starts");
        Launches {
            pending: HashMap::new(),
            order: VecDeque::new(),
            logs: HashMap::new(),
            jobs,
        }
    }

    /// Remembers request `id` until the UI reports its outcome.
    pub fn expect(&mut self, id: String, pending: Pending) {
        while self.order.len() >= PENDING_LIMIT {
            if let Some(oldest) = self.order.pop_front() {
                self.pending.remove(&oldest);
            }
        }
        self.order.push_back(id.clone());
        self.pending.insert(id, pending);
    }

    /// Starts logging `card`'s output when request `request` asked for it. Call before the card's
    /// terminal starts, so the log has all of its output. `cols` is the terminal's width, if known.
    pub fn begin_output(&mut self, request: &str, card: &str, cols: Option<u16>) {
        let Some(pending) = self.pending.get(request).filter(|pending| pending.log) else {
            return;
        };
        let file = log_path(&pending.inbox, request);
        let _ = self.jobs.send(Job::Create(file.clone()));
        let mut plain = PlainText::new();
        plain.set_width(cols.map_or(0, usize::from));
        self.logs.insert(
            card.to_owned(),
            OutputLog {
                file,
                plain,
                bytes: 0,
                quiet: 0,
            },
        );
    }

    /// Follows `card`'s new terminal width, so its log joins wrapped rows.
    pub fn resize(&mut self, card: &str, cols: u16) {
        if let Some(log) = self.logs.get_mut(card) {
            log.plain.set_width(cols.into());
        }
    }

    /// Appends terminal output to `card`'s log, if it has one.
    pub fn output(&mut self, card: &str, data: &str) {
        let Some(log) = self.logs.get_mut(card) else { return };
        log.quiet = 0;
        let text = log.plain.feed(data);
        self.append(card, text);
    }

    /// Writes the rows held back by logs whose output has paused. Call on every host poll.
    pub fn idle(&mut self) {
        let mut paused = Vec::new();
        for (card, log) in &mut self.logs {
            log.quiet = log.quiet.saturating_add(1);
            if log.quiet == IDLE_POLLS {
                paused.push((card.clone(), log.plain.idle()));
            }
        }
        for (card, text) in paused {
            self.append(&card, text);
        }
    }

    /// Appends `text` to `card`'s log, up to the size limit.
    fn append(&mut self, card: &str, mut text: String) {
        let Some(log) = self.logs.get_mut(card) else { return };
        if log.bytes + text.len() > LOG_BYTES {
            let mut end = LOG_BYTES.saturating_sub(log.bytes).min(text.len());
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
            text.push_str("\n[Terminal Canvas: this log stopped at 16 MB; the terminal keeps running]\n");
            let _ = self.jobs.send(Job::Append(log.file.clone(), text));
            self.logs.remove(card);
            return;
        }
        if text.is_empty() {
            return;
        }
        log.bytes += text.len();
        let _ = self.jobs.send(Job::Append(log.file.clone(), text));
    }

    /// Stops logging `card` without a note: its terminal never started.
    pub fn forget_output(&mut self, card: &str) {
        self.logs.remove(card);
    }

    /// Ends `card`'s log with its exit code, so a reader knows the terminal finished.
    pub fn exited(&mut self, card: &str, code: i64) {
        if let Some(log) = self.logs.get_mut(card) {
            let text = log.plain.idle();
            self.append(card, text);
        }
        if let Some(log) = self.logs.remove(card) {
            let _ = self.jobs.send(Job::Append(
                log.file,
                format!("\n[Terminal Canvas: the process exited with code {code}]\n"),
            ));
        }
    }

    /// Answers request `id` with the card the UI opened (and the card it opened beside, if any), or
    /// why it opened none. Returns whether the request was waiting.
    pub fn answer(&mut self, id: &str, card: Option<&str>, parent: Option<&str>, error: Option<&str>) -> bool {
        let Some(pending) = self.pending.remove(id) else {
            return false;
        };
        self.order.retain(|waiting| waiting != id);
        if pending.reply {
            let result = match (card, error) {
                (Some(card), None) => {
                    let mut opened = json!({ "status": "opened", "card": card });
                    if let Some(parent) = parent {
                        opened["parent"] = json!(parent);
                    }
                    if pending.log {
                        opened["log"] = json!(log_path(&pending.inbox, id).to_string_lossy());
                    }
                    opened
                }
                (_, error) => {
                    json!({ "status": "failed", "error": error.unwrap_or("The terminal could not be opened.") })
                }
            };
            write_result(&pending.inbox, id, &result);
        }
        true
    }

    /// Answers a request that was refused before it reached the UI.
    pub fn refuse(inbox: &std::path::Path, id: &str, error: &str) {
        write_result(inbox, id, &json!({ "status": "refused", "error": error }));
    }

    #[cfg(test)]
    fn waiting(&self) -> usize {
        self.pending.len()
    }
}

fn private_options(create: bool) -> OpenOptions {
    let mut options = OpenOptions::new();
    if create {
        options.write(true).create(true).truncate(true);
    } else {
        options.append(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

/// A parsed `launch-result` payload.
#[derive(Debug, PartialEq, Eq)]
pub struct LaunchResult {
    pub request: String,
    pub card: Option<String>,
    /// The card the new one actually opened beside; absent when it opened on its own.
    pub parent: Option<String>,
    pub error: Option<String>,
}

/// The `launch-result` payload: `{ request, card, parent? }` or `{ request, error }`.
pub fn parse_result(payload: Option<&Value>) -> Result<LaunchResult, String> {
    let invalid = || "Invalid terminal request result.".to_owned();
    let field = |key: &str| payload.and_then(|payload| payload.get(key));
    let text = |key: &str| field(key).and_then(Value::as_str);
    let request = text("request")
        .filter(|id| tc_core::launch::is_request_id(id))
        .ok_or_else(invalid)?;
    let card = text("card").filter(|card| tc_core::launch::is_request_id(card));
    let error = text("error").map(|error| error.chars().take(1000).collect::<String>());
    if card.is_none() == error.is_none() {
        return Err(invalid());
    }
    let parent = match field("parent") {
        None | Some(Value::Null) => None,
        Some(parent) => match parent.as_str() {
            Some(parent) if card.is_some() && tc_core::launch::is_request_id(parent) => Some(parent.to_owned()),
            _ => return Err(invalid()),
        },
    };
    Ok(LaunchResult {
        request: request.to_owned(),
        card: card.map(str::to_owned),
        parent,
        error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inbox() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let next = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("tc-launches-{}-{next}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn read_when(file: &std::path::Path, done: impl Fn(&str) -> bool) -> String {
        for _ in 0..100 {
            if let Ok(text) = std::fs::read_to_string(file)
                && done(&text)
            {
                return text;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        std::fs::read_to_string(file).unwrap_or_default()
    }

    #[test]
    fn answers_name_the_card_and_logs_follow_its_output_until_exit() {
        let inbox = inbox();
        let mut launches = Launches::new();
        let pending = |reply, log| Pending {
            inbox: inbox.clone(),
            reply,
            log,
        };
        launches.expect("req-1".into(), pending(true, true));
        launches.begin_output("req-1", "card-1", None);
        launches.output("card-1", "\x1b[32mhello\x1b[0m\r\n");
        launches.output("other-card", "not logged");
        assert!(launches.answer("req-1", Some("card-1"), Some("parent-1"), None));
        assert!(
            !launches.answer("req-1", Some("card-1"), None, None),
            "a request is answered once"
        );
        let result: Value =
            serde_json::from_str(&std::fs::read_to_string(inbox.join("req-1.result")).unwrap()).unwrap();
        let log = inbox.join("req-1.log");
        assert_eq!(
            result,
            json!({ "status": "opened", "card": "card-1", "parent": "parent-1", "log": log.to_string_lossy() })
        );
        launches.exited("card-1", 7);
        launches.output("card-1", "after exit");
        let text = read_when(&log, |text| text.contains("exited"));
        assert_eq!(text, "hello\n\n[Terminal Canvas: the process exited with code 7]\n");

        launches.expect("req-2".into(), pending(true, false));
        launches.begin_output("req-2", "card-2", None);
        assert!(launches.answer("req-2", None, None, Some("Working directory is unavailable.")));
        let failed: Value =
            serde_json::from_str(&std::fs::read_to_string(inbox.join("req-2.result")).unwrap()).unwrap();
        assert_eq!(failed["status"], "failed");
        assert!(!inbox.join("req-2.log").exists(), "no log unless asked");

        launches.expect("req-3".into(), pending(false, false));
        assert!(launches.answer("req-3", Some("card-3"), None, None));
        launches.expect("req-4".into(), pending(true, false));
        assert!(launches.answer("req-4", Some("card-4"), None, None));
        let alone: Value = serde_json::from_str(&std::fs::read_to_string(inbox.join("req-4.result")).unwrap()).unwrap();
        assert_eq!(
            alone,
            json!({ "status": "opened", "card": "card-4" }),
            "no parent when none was used"
        );
        assert!(!inbox.join("req-3.result").exists(), "--no-wait senders get no answer");
        assert!(!launches.answer("unknown", Some("card"), None, None));
        std::fs::remove_dir_all(inbox).unwrap();
    }

    #[test]
    fn logs_write_held_rows_after_a_pause_and_follow_the_width() {
        let inbox = inbox();
        let mut launches = Launches::new();
        launches.expect(
            "req-1".into(),
            Pending {
                inbox: inbox.clone(),
                reply: false,
                log: true,
            },
        );
        launches.begin_output("req-1", "card-1", Some(80));
        launches.resize("card-1", 4);
        launches.output("card-1", "abcdefgh\rXY\r\n");
        launches.resize("card-1", 80);
        launches.output("card-1", "Counting 1%\r");
        launches.output("card-1", "Counting 9%\r");
        for _ in 1..IDLE_POLLS {
            launches.idle();
        }
        launches.output("card-1", "Counting 50%\r");
        for _ in 0..IDLE_POLLS {
            launches.idle();
        }
        let log = inbox.join("req-1.log");
        assert_eq!(
            read_when(&log, |text| text.contains("50%")),
            "abcdXYgh\nCounting 50%",
            "only a row left unchanged for the whole pause is written"
        );
        launches.output("card-1", "Counting 100%\r\n> ");
        launches.exited("card-1", 0);
        let text = read_when(&log, |text| text.contains("exited"));
        assert_eq!(
            text,
            "abcdXYgh\nCounting 50%\nCounting 100%\n>\n[Terminal Canvas: the process exited with code 0]\n"
        );
        std::fs::remove_dir_all(inbox).unwrap();
    }

    #[test]
    fn pending_requests_and_logs_are_bounded() {
        let inbox = inbox();
        let mut launches = Launches::new();
        for index in 0..PENDING_LIMIT + 5 {
            launches.expect(
                format!("req-{index}"),
                Pending {
                    inbox: inbox.clone(),
                    reply: false,
                    log: index == PENDING_LIMIT + 4,
                },
            );
        }
        assert_eq!(launches.waiting(), PENDING_LIMIT);
        assert!(
            !launches.answer("req-0", Some("card"), None, None),
            "the oldest are forgotten"
        );
        let last = format!("req-{}", PENDING_LIMIT + 4);
        launches.begin_output(&last, "big", None);
        let rows = format!("{}\n", "x".repeat(1023)).repeat(LOG_BYTES / 1024);
        launches.output("big", &rows[..LOG_BYTES - 2]);
        launches.output("big", "yyyy\n");
        launches.output("big", "ignored");
        let log = inbox.join(format!("{last}.log"));
        let text = read_when(&log, |text| text.contains("stopped"));
        assert!(text.starts_with(&rows[..LOG_BYTES - 2]));
        assert!(text.contains("yy\n[Terminal Canvas: this log stopped at 16 MB"));
        assert!(!text.contains("ignored"));
        std::fs::remove_dir_all(inbox).unwrap();
    }

    #[test]
    fn results_name_a_known_request_and_one_outcome() {
        assert_eq!(
            parse_result(Some(&json!({ "request": "abc-1", "card": "card-1" }))).unwrap(),
            LaunchResult {
                request: "abc-1".into(),
                card: Some("card-1".into()),
                parent: None,
                error: None
            }
        );
        assert_eq!(
            parse_result(Some(
                &json!({ "request": "abc-1", "card": "card-1", "parent": "lead-1" })
            ))
            .unwrap()
            .parent
            .as_deref(),
            Some("lead-1")
        );
        assert_eq!(
            parse_result(Some(&json!({ "request": "abc-1", "error": "x".repeat(2000) })))
                .unwrap()
                .error
                .unwrap()
                .len(),
            1000
        );
        for bad in [
            json!(null),
            json!({ "request": "../x", "card": "c" }),
            json!({ "request": "a" }),
            json!({ "request": "a", "card": "c", "error": "e" }),
            json!({ "request": "a", "card": "c/d" }),
            json!({ "request": "a", "card": "c", "parent": "../p" }),
            json!({ "request": "a", "card": "c", "parent": 7 }),
            json!({ "request": "a", "error": "e", "parent": "p" }),
        ] {
            assert!(parse_result(Some(&bad)).is_err(), "{bad}");
        }
    }
}
