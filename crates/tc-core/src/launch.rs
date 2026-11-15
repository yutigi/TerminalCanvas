//! Terminal launch requests: a program asks the canvas to open a new terminal, such as an AI agent
//! handing its work over to a fresh session or starting a helper. Any program can ask; nothing here
//! is specific to one agent.
//!
//! Requests are JSON files dropped into an inbox folder, which the host polls. It removes each
//! request it reads and tells the UI to create the card. There are two kinds of inbox:
//!
//! - Each integrated terminal gets a private inbox, named by `TC_LAUNCH_DIR` and created in the
//!   system temporary folder, which agent sandboxes usually allow writing to. A request there opens
//!   its card beside that terminal, joined to it by an arrow.
//! - The app has one inbox in its data folder, `launch-requests`, for programs outside the canvas.
//!   Those requests may name a `parent` card (each terminal's ID is in `TC_CARD_ID`); without one,
//!   the card opens in view on its own.
//!
//! Each request file is named `<request id>.json`. When its sender waits (`reply`), the host answers
//! in the same inbox with `<request id>.result`: the opened card's ID, or why nothing opened. With
//! `log`, the host also writes the new terminal's output as plain text to `<request id>.log` there,
//! so the sender can follow what it started.
//!
//! Requests go through folders instead of terminal output because agents run commands with captured
//! output, and because anything printed to a terminal (a file being viewed, a remote server) must
//! never be able to start a process.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Value, json};

use crate::atomic::{self, Access};
use crate::osc::is_absolute;
use crate::workspace::{ProfileId, create_card};
use crate::{Error, Platform, Result};

/// The environment variable that names a terminal's request inbox.
pub const ENV: &str = "TC_LAUNCH_DIR";
/// The environment variable that holds a terminal's card ID, for requests that name a parent.
pub const CARD_ENV: &str = "TC_CARD_ID";
/// Overrides the app data folder whose inbox programs outside the canvas use.
pub const DATA_ENV: &str = "TERMINAL_CANVAS_DATA";
/// The app inbox's folder name inside the app data folder.
pub const APP_INBOX: &str = "launch-requests";
/// The longest parent card ID accepted.
const PARENT_LENGTH: usize = 128;
/// The largest request file read, in bytes.
pub const REQUEST_BYTES: u64 = 16 * 1024;
/// The most requests one terminal may have handled per poll.
pub const REQUESTS_PER_POLL: usize = 4;
/// The extension of a finished request; temporary files from atomic writes end in `.tmp`.
pub const EXTENSION: &str = "json";

/// A validated request, with the card defaults its profile supplies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LaunchRequest {
    pub profile: ProfileId,
    pub title: String,
    pub cwd: String,
    pub command: String,
    /// The card to open beside. Only the app inbox reads it: a terminal's own inbox always
    /// opens beside that terminal.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    /// The sender waits for a `<request id>.result` answer.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub reply: bool,
    /// The sender wants the new terminal's output in `<request id>.log`.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub log: bool,
}

/// A request taken from an inbox. `id` is `None` for a file not named like a request, which is
/// refused without an answer.
#[derive(Debug)]
pub struct Taken {
    pub id: Option<String>,
    pub request: Result<LaunchRequest>,
}

/// Whether `id` can name a request: the file names [`write_request`] creates, so the answer and log
/// paths derived from it stay inside the inbox.
pub fn is_request_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Where the answer to request `id` goes.
pub fn result_path(inbox: &Path, id: &str) -> PathBuf {
    inbox.join(format!("{id}.result"))
}

/// Where the output of the terminal request `id` opened goes, when the request asked for it.
pub fn log_path(inbox: &Path, id: &str) -> PathBuf {
    inbox.join(format!("{id}.log"))
}

/// Answers request `id` in `inbox`, atomically. A missing inbox (its terminal ended) is ignored.
pub fn write_result(inbox: &Path, id: &str, result: &Value) {
    if is_request_id(id) {
        let _ = atomic::write(&result_path(inbox, id), result.to_string().as_bytes(), Access::Private);
    }
}

fn invalid<T>(message: &str) -> Result<T> {
    Err(Error::Invalid(message.to_owned()))
}

/// Checks a request with the card rules the New terminal dialog uses. A missing title or command
/// takes the profile's default; the folder must be an absolute path.
pub fn validate_request(raw: &Value, platform: Platform) -> Result<LaunchRequest> {
    let Value::Object(fields) = raw else {
        return invalid("Invalid terminal request.");
    };
    let text = |key: &str| match fields.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(Error::Invalid(format!("Invalid terminal request {key}."))),
    };
    let profile = match text("profile")? {
        None => ProfileId::Shell,
        Some(profile) => match ProfileId::parse(&profile) {
            Some(profile) => profile,
            None => return invalid("Unknown terminal profile."),
        },
    };
    let (title, cwd, command, parent) = (text("title")?, text("cwd")?, text("command")?, text("parent")?);
    let flag = |key: &str| match fields.get(key) {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err(Error::Invalid(format!("Invalid terminal request {key}."))),
    };
    let (reply, log) = (flag("reply")?, flag("log")?);
    let parent_ok = |id: &str| {
        !id.is_empty()
            && id.len() <= PARENT_LENGTH
            && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    };
    if parent.as_deref().is_some_and(|id| !parent_ok(id)) {
        return invalid("Invalid terminal request parent.");
    }
    let Some(cwd) = cwd.filter(|cwd| !cwd.is_empty()) else {
        return invalid("A terminal request needs a working directory.");
    };
    if !is_absolute(&cwd, platform) {
        return invalid("A terminal request's working directory must be an absolute path.");
    }
    let card = create_card(&json!({
        "profile": profile.as_str(),
        "title": title,
        "cwd": cwd,
        "command": command,
    }))?;
    Ok(LaunchRequest {
        profile: card.profile,
        title: card.title,
        cwd: card.cwd,
        command: card.command,
        parent,
        reply,
        log,
    })
}

/// The app inbox inside the app data folder `data`.
pub fn app_inbox(data: &Path) -> PathBuf {
    data.join(APP_INBOX)
}

/// A new, unpredictable inbox path for one terminal, in the system temporary folder.
pub fn terminal_inbox() -> PathBuf {
    std::env::temp_dir().join(format!("tc-launch-{}", uuid::Uuid::new_v4()))
}

/// Creates an owner-only inbox folder (mode 0700 on Unix). A `fresh` inbox must not exist yet, so a
/// folder someone else created in a shared temporary folder is never used.
pub fn create_inbox(inbox: &Path, fresh: bool) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(!fresh);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(inbox)
}

/// Removes every request in `inbox`, finished or not. The app does this when it starts, so a
/// request left while it was closed never opens a terminal later.
pub fn discard_requests(inbox: &Path) {
    let Ok(entries) = fs::read_dir(inbox) else { return };
    for entry in entries.flatten() {
        if entry.file_type().is_ok_and(|kind| kind.is_file()) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Writes `request` into `inbox` atomically and returns its ID and file.
pub fn write_request(inbox: &Path, request: &LaunchRequest) -> io::Result<(String, PathBuf)> {
    let id = uuid::Uuid::new_v4().to_string();
    let file = inbox.join(format!("{id}.{EXTENSION}"));
    let text = serde_json::to_string(request).expect("requests serialize");
    atomic::write(&file, text.as_bytes(), Access::Private)?;
    Ok((id, file))
}

/// Moves request `file` aside under a name ending in `suffix`, which no poll takes. A rename is
/// atomic, so when the app takes a request while its sender withdraws it, exactly one succeeds.
fn claim(file: &Path, suffix: &str) -> io::Result<PathBuf> {
    let mut claimed = file.with_extension("").into_os_string();
    claimed.push(suffix);
    let claimed = PathBuf::from(claimed);
    fs::rename(file, &claimed)?;
    Ok(claimed)
}

/// Withdraws a request the app has not taken, so it never opens a terminal. Returns `false` when the
/// app took it first (or it is gone for another reason): a terminal may then still open.
pub fn withdraw_request(file: &Path) -> bool {
    match claim(file, ".withdrawn") {
        Ok(claimed) => {
            let _ = fs::remove_file(claimed);
            true
        }
        Err(_) => false,
    }
}

/// Takes up to [`REQUESTS_PER_POLL`] finished requests from `inbox`, oldest first, removing each
/// file. Each request is parsed, or carries the reason it was refused. A request is claimed before
/// it is read, so one its sender withdrew at the same moment is skipped, never opened.
pub fn take_requests(inbox: &Path, platform: Platform) -> Vec<Taken> {
    let Ok(entries) = fs::read_dir(inbox) else {
        return Vec::new();
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some(EXTENSION) {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            metadata
                .is_file()
                .then(|| (metadata.modified().unwrap_or(std::time::UNIX_EPOCH), path))
        })
        .collect();
    files.sort();
    files
        .into_iter()
        .take(REQUESTS_PER_POLL)
        .filter_map(|(_, file)| {
            // Withdrawn by its sender since the folder was listed.
            let claimed = claim(&file, ".taken").ok()?;
            let read = read_request(&claimed);
            // A request runs at most once, even when it cannot be parsed.
            let _ = fs::remove_file(&claimed);
            let id = file
                .file_stem()
                .and_then(|stem| stem.to_str())
                .filter(|stem| is_request_id(stem))
                .map(str::to_owned);
            let request = match &id {
                Some(_) => read.and_then(|raw| validate_request(&raw, platform)),
                None => invalid("Invalid terminal request name."),
            };
            Some(Taken { id, request })
        })
        .collect()
}

fn read_request(file: &Path) -> Result<Value> {
    if fs::metadata(file)?.len() > REQUEST_BYTES {
        return invalid("Terminal requests must be smaller than 16 KB.");
    }
    let text = fs::read_to_string(file)?;
    serde_json::from_str(&text).map_err(|_| Error::Invalid("Invalid terminal request.".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tc-launch-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn requests_take_profile_defaults_and_card_limits() {
        let claude = validate_request(&json!({ "profile": "claude", "cwd": "/repo" }), Platform::Linux).unwrap();
        assert_eq!(
            claude,
            LaunchRequest {
                profile: ProfileId::Claude,
                title: "Claude Code".into(),
                cwd: "/repo".into(),
                command: "claude".into(),
                parent: None,
                reply: false,
                log: false,
            }
        );
        let flags = validate_request(&json!({ "cwd": "/repo", "reply": true, "log": true }), Platform::Linux).unwrap();
        assert!(flags.reply && flags.log);
        assert!(validate_request(&json!({ "cwd": "/repo", "log": "yes" }), Platform::Linux).is_err());
        let child = validate_request(&json!({ "cwd": "/repo", "parent": "4b0c-card_1" }), Platform::Linux).unwrap();
        assert_eq!(child.parent.as_deref(), Some("4b0c-card_1"));
        for parent in [json!(""), json!("../x"), json!("a b"), json!("x".repeat(129)), json!(7)] {
            assert!(validate_request(&json!({ "cwd": "/repo", "parent": parent }), Platform::Linux).is_err());
        }
        let shell = validate_request(
            &json!({ "title": "Handover", "cwd": "C:\\repo", "command": "claude \"read it\"" }),
            Platform::Windows,
        )
        .unwrap();
        assert_eq!((shell.profile, shell.title.as_str()), (ProfileId::Shell, "Handover"));
        assert_eq!(shell.command, "claude \"read it\"");
        let reject = |raw: Value, platform| validate_request(&raw, platform).unwrap_err().to_string();
        assert_eq!(reject(json!([]), Platform::Linux), "Invalid terminal request.");
        assert_eq!(
            reject(json!({ "cwd": "/a", "profile": "vim" }), Platform::Linux),
            "Unknown terminal profile."
        );
        assert_eq!(
            reject(json!({ "command": "ls" }), Platform::Linux),
            "A terminal request needs a working directory."
        );
        assert_eq!(
            reject(json!({ "cwd": "relative" }), Platform::Linux),
            "A terminal request's working directory must be an absolute path."
        );
        assert_eq!(
            reject(json!({ "cwd": "C:\\repo" }), Platform::Linux),
            "A terminal request's working directory must be an absolute path."
        );
        assert_eq!(
            reject(json!({ "cwd": "/a", "title": 5 }), Platform::Linux),
            "Invalid terminal request title."
        );
        assert!(validate_request(&json!({ "cwd": "/a", "command": "x".repeat(2001) }), Platform::Linux).is_err());
    }

    #[test]
    fn inbox_requests_are_taken_once_in_bounded_batches() {
        let inbox = folder();
        let request = validate_request(&json!({ "cwd": "/a", "command": "ls" }), Platform::Linux).unwrap();
        for _ in 0..REQUESTS_PER_POLL + 1 {
            write_request(&inbox, &request).unwrap();
        }
        fs::write(inbox.join("broken.json"), "{").unwrap();
        fs::write(inbox.join("pending.json.1234.tmp"), "{}").unwrap();
        fs::write(inbox.join("huge.json"), " ".repeat(REQUEST_BYTES as usize + 1)).unwrap();
        fs::write(inbox.join("bad name.json"), "{}").unwrap();
        let mut taken = Vec::new();
        for _ in 0..3 {
            taken.extend(take_requests(&inbox, Platform::Linux));
        }
        assert_eq!(taken.len(), REQUESTS_PER_POLL + 4);
        assert_eq!(
            taken
                .iter()
                .filter(|taken| taken.request.as_ref().ok() == Some(&request) && taken.id.is_some())
                .count(),
            REQUESTS_PER_POLL + 1
        );
        let errors: Vec<String> = taken
            .iter()
            .filter_map(|taken| taken.request.as_ref().err().map(ToString::to_string))
            .collect();
        assert!(errors.contains(&"Invalid terminal request.".to_owned()));
        assert!(errors.contains(&"Terminal requests must be smaller than 16 KB.".to_owned()));
        assert!(errors.contains(&"Invalid terminal request name.".to_owned()));
        assert!(
            taken.iter().any(|taken| taken.id.is_none()),
            "an oddly named file gets no answer"
        );
        let left: Vec<_> = fs::read_dir(&inbox).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(left, ["pending.json.1234.tmp"], "only unfinished writes remain");
        assert!(take_requests(&inbox.join("missing"), Platform::Linux).is_empty());
        write_request(&inbox, &request).unwrap();
        discard_requests(&inbox);
        assert_eq!(
            fs::read_dir(&inbox).unwrap().count(),
            0,
            "startup discards stale requests"
        );
        fs::remove_dir_all(inbox).unwrap();
    }

    #[test]
    fn a_request_is_either_taken_or_withdrawn_never_both() {
        let inbox = folder();
        let request = validate_request(&json!({ "cwd": "/a" }), Platform::Linux).unwrap();
        let (_, withdrawn) = write_request(&inbox, &request).unwrap();
        assert!(withdraw_request(&withdrawn));
        assert!(
            take_requests(&inbox, Platform::Linux).is_empty(),
            "a withdrawn request never opens"
        );
        assert_eq!(fs::read_dir(&inbox).unwrap().count(), 0, "nothing is left behind");

        let (id, taken) = write_request(&inbox, &request).unwrap();
        let polled = take_requests(&inbox, Platform::Linux);
        assert_eq!(polled.len(), 1);
        assert_eq!(polled[0].id.as_deref(), Some(id.as_str()));
        assert!(
            !withdraw_request(&taken),
            "once the app has taken a request, its sender learns a terminal may still open"
        );
        assert_eq!(fs::read_dir(&inbox).unwrap().count(), 0);
        fs::remove_dir_all(inbox).unwrap();
    }

    #[test]
    fn answers_and_logs_stay_inside_the_inbox() {
        let inbox = folder();
        let (id, file) = write_request(
            &inbox,
            &validate_request(&json!({ "cwd": "/a" }), Platform::Linux).unwrap(),
        )
        .unwrap();
        assert!(is_request_id(&id));
        assert_eq!(file, inbox.join(format!("{id}.json")));
        assert_eq!(result_path(&inbox, &id), inbox.join(format!("{id}.result")));
        assert_eq!(log_path(&inbox, &id), inbox.join(format!("{id}.log")));
        write_result(&inbox, &id, &json!({ "status": "opened" }));
        assert_eq!(
            fs::read_to_string(result_path(&inbox, &id)).unwrap(),
            r#"{"status":"opened"}"#
        );
        for bad in ["", "../x", "a/b", "a.b", &"x".repeat(65)] {
            assert!(!is_request_id(bad), "{bad}");
        }
        write_result(&inbox, "../escape", &json!({}));
        assert!(!inbox.parent().unwrap().join("escape.result").exists());
        write_result(&inbox.join("gone"), &id, &json!({}));
        fs::remove_dir_all(inbox).unwrap();
    }

    #[test]
    fn terminal_inboxes_are_fresh_private_folders() {
        let inbox = terminal_inbox();
        assert_ne!(inbox, terminal_inbox());
        create_inbox(&inbox, true).unwrap();
        assert!(
            create_inbox(&inbox, true).is_err(),
            "an existing folder is never reused"
        );
        create_inbox(&inbox, false).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&inbox).unwrap().permissions().mode() & 0o777, 0o700);
        }
        fs::remove_dir_all(inbox).unwrap();
    }
}
