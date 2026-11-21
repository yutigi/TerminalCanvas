//! Optional format-3 arrow automation and the private, bounded hook transport.
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::atomic::{self, Access};
use crate::js::utf16_len;
use crate::session::Provider;
use crate::workspace::{Endpoint, ItemKind, Workspace};
use crate::{Result, invalid};

pub const TEXT_UNITS: usize = 2000;
pub const MESSAGE_UNITS: usize = 1000;
pub const REQUEST_BYTES: u64 = 16384;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Event {
    Stop,
    Exit,
    Trigger,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Action {
    Shell,
    Prompt,
    NewTerminal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum Filter {
    #[default]
    Any,
    Success,
    Failure,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pointer {
    pub event: Event,
    pub action: Action,
    pub text: String,
    pub armed: bool,
    #[serde(default)]
    pub filter: Filter,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub context: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<Provider>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

pub fn validate(raw: &Value) -> Result<Pointer> {
    let Ok(pointer) = serde_json::from_value::<Pointer>(raw.clone()) else {
        return invalid("Invalid hook pointer configuration.");
    };
    if pointer.text.trim().is_empty()
        || utf16_len(&pointer.text) > TEXT_UNITS
        || pointer
            .text
            .chars()
            .any(|c| c.is_control() && !(pointer.action == Action::Prompt && matches!(c, '\n' | '\t')))
        || !valid_name(&pointer.name)
        || (pointer.event != Event::Trigger && !pointer.name.is_empty())
        || (pointer.event != Event::Exit && pointer.filter != Filter::Any)
        || (pointer.context && pointer.action != Action::Prompt)
        || (pointer.provider.is_some() && pointer.action != Action::Prompt)
        || pointer
            .model
            .as_deref()
            .is_some_and(|model| pointer.provider.is_none() || !valid_model(model))
    {
        return invalid("Invalid hook pointer configuration.");
    }
    Ok(pointer)
}

pub fn valid_name(name: &str) -> bool {
    name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

fn valid_model(model: &str) -> bool {
    model.len() <= 128
        && model.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
        && model
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:/[]+".contains(&byte))
}

/// A single-use prompt passed to a CLI outside the shell's input and history.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PromptLaunch {
    pub provider: Provider,
    pub model: Option<String>,
    pub text: String,
    pub expires: u64,
}

impl PromptLaunch {
    pub fn write(&self, inbox: &Path) -> io::Result<(String, PathBuf)> {
        let id = uuid::Uuid::new_v4().to_string();
        let path = inbox.join(format!("{id}.prompt-launch"));
        atomic::write(&path, &serde_json::to_vec(self)?, Access::Private)?;
        Ok((id, path))
    }

    pub fn take(inbox: &Path, id: &str) -> io::Result<Self> {
        if !crate::launch::is_request_id(id) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let path = inbox.join(format!("{id}.prompt-launch"));
        if !fs::symlink_metadata(&path)?.is_file() {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let mut bytes = Vec::new();
        fs::File::open(&path)?.take(REQUEST_BYTES + 1).read_to_end(&mut bytes)?;
        fs::remove_file(path)?;
        if bytes.len() as u64 > REQUEST_BYTES {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let launch: Self = serde_json::from_slice(&bytes)?;
        if launch.expires <= now_ms()
            || launch.text.trim().is_empty()
            || launch.text.chars().any(|c| c.is_control() && !matches!(c, '\n' | '\t'))
            || launch.model.as_deref().is_some_and(|model| !valid_model(model))
        {
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok(launch)
    }
}

pub fn ends(item: &crate::workspace::Item) -> Option<(&str, &str)> {
    match &item.kind {
        ItemKind::Line {
            start: Endpoint::Element(source),
            end: Endpoint::Element(target),
            arrow: true,
        } => Some((source, target)),
        _ => None,
    }
}

/// Reject cycles including disarmed edges: arming any saved subset must also be safe.
pub fn validate_graph(board: &Workspace) -> Result<()> {
    let cards: HashSet<&str> = board.cards.iter().map(|c| c.id.as_str()).collect();
    let mut edges: HashMap<&str, Vec<&str>> = HashMap::new();
    for item in board.items.iter().filter(|item| item.hook.is_some()) {
        let Some((source, target)) = ends(item) else {
            return invalid("Hook pointers need a terminal-to-terminal arrow.");
        };
        if !cards.contains(source) || !cards.contains(target) {
            return invalid("Hook pointers need a terminal-to-terminal arrow.");
        }
        edges.entry(source).or_default().push(target);
    }
    fn visit<'a>(
        node: &'a str,
        edges: &HashMap<&'a str, Vec<&'a str>>,
        active: &mut HashSet<&'a str>,
        done: &mut HashSet<&'a str>,
    ) -> bool {
        if done.contains(node) {
            return true;
        }
        if !active.insert(node) {
            return false;
        }
        if edges
            .get(node)
            .is_some_and(|targets| targets.iter().any(|target| !visit(target, edges, active, done)))
        {
            return false;
        }
        active.remove(node);
        done.insert(node);
        true
    }
    let (mut active, mut done) = (HashSet::new(), HashSet::new());
    if edges.keys().any(|node| !visit(node, &edges, &mut active, &mut done)) {
        return invalid("Hook pointers cannot form a cycle.");
    }
    Ok(())
}

/// Lifecycle events never carry transcripts, prompts, or arbitrary hook input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Report {
    pub kind: String,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub exit_code: Option<i64>,
    #[serde(default)]
    pub stop_hook_active: bool,
    pub expires: u64,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

impl Report {
    pub fn valid(&self) -> bool {
        matches!(
            self.kind.as_str(),
            "stop" | "busy" | "failed" | "interrupt" | "session-end" | "trigger"
        ) && (self.kind == "trigger" || matches!(self.provider.as_str(), "claude" | "codex"))
            && self.token.len() <= 64
            && self.session_id.len() <= 64
            && (self.session_id.is_empty() || crate::session::is_session_id(&self.session_id))
            && utf16_len(&self.message) <= MESSAGE_UNITS
            && !self
                .message
                .chars()
                .any(|c| c.is_control() && !matches!(c, '\n' | '\t'))
            && valid_name(&self.name)
            && self.expires > now_ms()
            && self.expires <= now_ms().saturating_add(5000)
    }
}

impl Pointer {
    pub fn matches(&self, report: &Report) -> bool {
        self.armed
            && match self.event {
                Event::Stop => report.kind == "stop",
                Event::Trigger => report.kind == "trigger" && (self.name.is_empty() || self.name == report.name),
                Event::Exit => {
                    report.kind == "exit"
                        && match self.filter {
                            Filter::Any => true,
                            Filter::Success => report.exit_code == Some(0),
                            Filter::Failure => report.exit_code.is_some_and(|code| code != 0),
                        }
                }
            }
    }

    pub fn payload(&self, report: &Report) -> String {
        if !self.context {
            return self.text.clone();
        }
        format!(
            "{}\n\nSource session: {}\nExit code: {}\nSource message:\n{}",
            self.text,
            report.session_id,
            report
                .exit_code
                .map_or_else(|| "unavailable".into(), |code| code.to_string()),
            report.message
        )
    }
}

pub fn answer_path(inbox: &Path, id: &str) -> PathBuf {
    inbox.join(format!("{id}.hook-answer"))
}

pub fn write_request(inbox: &Path, report: &Report) -> io::Result<(String, PathBuf)> {
    let id = uuid::Uuid::new_v4().to_string();
    let file = inbox.join(format!("{id}.hook"));
    atomic::write(&file, serde_json::to_string(report)?.as_bytes(), Access::Private)?;
    Ok((id, file))
}

pub fn answer(inbox: &Path, id: &str, value: &Value) -> io::Result<()> {
    if !crate::launch::is_request_id(id) {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    atomic::write(&answer_path(inbox, id), value.to_string().as_bytes(), Access::Private)
}

/// Claims at most 16 requests per poll; bounded reads reject oversized or linked files.
pub fn take(inbox: &Path) -> Vec<(String, Report)> {
    let Ok(entries) = fs::read_dir(inbox) else {
        return Vec::new();
    };
    let mut files = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            (path.extension()?.to_str()? == "hook" && entry.file_type().ok()?.is_file()).then_some(path)
        })
        .take(256)
        .collect::<Vec<_>>();
    files.sort();
    let mut taken = Vec::new();
    for file in files.into_iter().take(16) {
        let Some(id) = file
            .file_stem()
            .and_then(|s| s.to_str())
            .filter(|id| crate::launch::is_request_id(id))
        else {
            continue;
        };
        let claimed = file.with_extension("hook-taken");
        if fs::rename(&file, &claimed).is_err() {
            continue;
        }
        let report = (|| {
            let mut bytes = Vec::new();
            fs::File::open(&claimed)?
                .take(REQUEST_BYTES + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() as u64 > REQUEST_BYTES {
                return Err(io::ErrorKind::InvalidData.into());
            }
            serde_json::from_slice::<Report>(&bytes).map_err(io::Error::other)
        })();
        let _ = fs::remove_file(claimed);
        match report {
            Ok(report) if report.valid() => taken.push((id.to_owned(), report)),
            _ => {
                let _ = answer(
                    inbox,
                    id,
                    &serde_json::json!({"error":"Invalid or expired hook request."}),
                );
            }
        }
    }
    taken
}
