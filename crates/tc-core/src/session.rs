//! AI session metadata and the terminal output parser that finds it, from `src/session-metadata.cjs`.

use std::sync::LazyLock;

use regex::Regex;
use serde::ser::{Serialize, SerializeMap, Serializer};
use serde_json::{Map, Value};

use crate::Platform;
use crate::js::{has_c0_control, last_utf16, utf16_len};
use crate::node;

string_enum! {
    /// An AI CLI whose sessions can be resumed.
    pub enum Provider {
        Codex = "codex",
        Claude = "claude",
    }
}

/// The recovery metadata a card keeps. Nothing else from a CLI is ever stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionMetadata {
    pub provider: Provider,
    /// Lowercase.
    pub session_id: String,
    pub cwd: String,
}

impl Serialize for SessionMetadata {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(3))?;
        map.serialize_entry("provider", &self.provider)?;
        map.serialize_entry("sessionId", &self.session_id)?;
        map.serialize_entry("cwd", &self.cwd)?;
        map.end()
    }
}

/// `SESSION_ID`: a UUID in either case.
pub fn is_session_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, &b)| match index {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

/// A directory a session may report: present, at most 4096 UTF-16 units, and free of C0 controls.
pub fn valid_directory(value: &str) -> bool {
    !value.is_empty() && utf16_len(value) <= 4096 && !has_c0_control(value)
}

/// Keeps only the allowlisted fields of a saved or reported session, or returns `None`.
pub fn session_metadata(raw: &Value) -> Option<SessionMetadata> {
    let raw = raw.as_object()?;
    let provider = raw.get("provider").and_then(Value::as_str).and_then(Provider::parse)?;
    let session_id = raw
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|id| is_session_id(id))?;
    let cwd = raw
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|cwd| valid_directory(cwd))?;
    Some(SessionMetadata {
        provider,
        session_id: session_id.to_ascii_lowercase(),
        cwd: cwd.to_owned(),
    })
}

/// A change the parser observed. `session` is `Some(None)` when a launch carried no usable ID, which
/// must not replace a known conversation.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MetadataPatch {
    pub cwd: Option<String>,
    pub session: Option<Option<SessionMetadata>>,
}

impl Serialize for MetadataPatch {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        if let Some(cwd) = &self.cwd {
            map.serialize_entry("cwd", cwd)?;
        }
        if let Some(session) = &self.session {
            map.serialize_entry("session", session)?;
        }
        map.end()
    }
}

/// The token a launch reported. JavaScript compared tokens with `===`, so only a string token can
/// ever match the token of a later end event or hook file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchToken {
    Text(String),
    /// A token that passed the ID check only through JavaScript's string coercion, such as `["<uuid>"]`.
    Unmatchable,
}

impl LaunchToken {
    pub fn matches(&self, other: Option<&Value>) -> bool {
        matches!((self, other), (LaunchToken::Text(token), Some(Value::String(other))) if token == other)
    }
}

/// The AI CLI currently running in a terminal, as its launch event reported it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub provider: Provider,
    pub token: LaunchToken,
}

#[derive(Debug, Clone, PartialEq)]
pub enum MetadataEvent {
    Change(MetadataPatch),
    /// A launch event as the shell integration sent it.
    Launch(Value),
    /// An end event that matched the current launch.
    End(Value),
    Warning(String),
}

const BUFFER_UNITS: usize = 32768;
const TEXT_UNITS: usize = 4096;
static ANSI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]").expect("valid pattern"));
// `(?i-u)`: JavaScript's `i` flag without `u` never matches non-ASCII letters against ASCII ones.
static CODEX_PATTERNS: LazyLock<[Regex; 2]> = LazyLock::new(|| {
    [
        r"(?i-u)(?:^|[\r\n])[ \t]*To continue this session, run codex resume ([a-f0-9-]{36})\b",
        r"(?i-u)(?:^|[\r\n])[ \t]*session id:[ \t]*([a-f0-9-]{36})\b",
    ]
    .map(|pattern| Regex::new(pattern).expect("valid pattern"))
});

/// Inspects a bounded rolling buffer of terminal output. It never saves terminal text and never
/// infers IDs from unrelated output.
#[derive(Debug, Clone)]
pub struct MetadataParser {
    /// The last directory reported, used for Codex sessions found in output.
    pub cwd: String,
    platform: Platform,
    directories: bool,
    buffer: String,
    text: String,
    launch: Option<Launch>,
}

impl MetadataParser {
    /// `directories` enables OSC 7 reports; terminals track directories elsewhere and turn it off.
    pub fn new(cwd: impl Into<String>, platform: Platform, directories: bool) -> Self {
        MetadataParser {
            cwd: cwd.into(),
            platform,
            directories,
            buffer: String::new(),
            text: String::new(),
            launch: None,
        }
    }

    pub fn launch(&self) -> Option<&Launch> {
        self.launch.as_ref()
    }

    /// Output held back because it may begin a control sequence.
    pub fn buffer(&self) -> &str {
        &self.buffer
    }

    /// Recent Codex output, kept to find its session ID.
    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn feed(&mut self, data: &str, emit: &mut impl FnMut(MetadataEvent)) {
        let mut buffer = std::mem::take(&mut self.buffer);
        buffer.push_str(data);
        let excess = buffer.len() - last_utf16(&buffer, BUFFER_UNITS).len();
        buffer.drain(..excess);
        // `/\x1b\]([^\x07]*?)(?:\x07|\x1b\\)/`: the first OSC start, up to the first BEL or ST.
        while let Some((start, payload_end, end)) = find_osc(&buffer) {
            self.inspect_text(&buffer[..start], emit);
            let payload = buffer[start + 2..payload_end].to_owned();
            self.control(&payload, emit);
            buffer.drain(..end);
        }
        let end = match buffer.find("\x1b]") {
            Some(pending) => pending,
            None if buffer.ends_with('\x1b') => buffer.len() - 1,
            None => buffer.len(),
        };
        self.inspect_text(&buffer[..end], emit);
        buffer.drain(..end);
        self.buffer = buffer;
    }

    fn control(&mut self, value: &str, emit: &mut impl FnMut(MetadataEvent)) {
        // Malformed or non-local metadata must not break terminal output, so every failure is ignored.
        if self.directories && value.starts_with("7;file://") {
            self.directory_report(&value[2..], emit);
        }
        if let Some(encoded) = value.strip_prefix("633;TC;") {
            self.integration_event(encoded, emit);
        }
    }

    fn directory_report(&mut self, uri: &str, emit: &mut impl FnMut(MetadataEvent)) {
        let Some(url) = node::parse_url(uri) else { return };
        let hostname = url.hostname();
        // WHATWG URLs already turn `localhost` into an empty host.
        if !hostname.is_empty() && hostname != "localhost" {
            return;
        }
        let Some(cwd) = node::file_url_to_path(hostname, url.pathname(), self.platform.is_windows()) else {
            return;
        };
        if valid_directory(&cwd) {
            self.cwd.clone_from(&cwd);
            emit(MetadataEvent::Change(MetadataPatch {
                cwd: Some(cwd),
                session: None,
            }));
        }
    }

    fn integration_event(&mut self, encoded: &str, emit: &mut impl FnMut(MetadataEvent)) {
        let decoded = node::base64_decode(encoded);
        let Ok(event) = serde_json::from_str::<Value>(&String::from_utf8_lossy(&decoded)) else {
            return;
        };
        let Some(fields) = event.as_object() else { return };
        let kind = fields.get("type").and_then(Value::as_str);
        if kind == Some("warning")
            && let Some(Value::String(message)) = fields.get("message")
            && utf16_len(message) <= 512
        {
            emit(MetadataEvent::Warning(message.clone()));
        }
        if kind == Some("cwd")
            && let Some(cwd) = fields
                .get("cwd")
                .and_then(Value::as_str)
                .filter(|cwd| valid_directory(cwd))
        {
            self.cwd = cwd.to_owned();
            emit(MetadataEvent::Change(MetadataPatch {
                cwd: Some(cwd.to_owned()),
                session: None,
            }));
        }
        if kind == Some("launch")
            && let Some(provider) = fields.get("provider").and_then(Value::as_str).and_then(Provider::parse)
            && coerced_token(fields.get("token")).is_some_and(is_session_id)
            && let Some(cwd) = fields
                .get("cwd")
                .and_then(Value::as_str)
                .filter(|cwd| valid_directory(cwd))
        {
            let token = match fields.get("token") {
                Some(Value::String(token)) => LaunchToken::Text(token.clone()),
                _ => LaunchToken::Unmatchable,
            };
            self.launch = Some(Launch { provider, token });
            self.cwd = cwd.to_owned();
            self.text.clear();
            let session = session_metadata(&event);
            let cwd = cwd.to_owned();
            emit(MetadataEvent::Launch(event.clone()));
            emit(MetadataEvent::Change(MetadataPatch {
                cwd: Some(cwd),
                session: Some(session),
            }));
        }
        if kind == Some("end")
            && self
                .launch
                .as_ref()
                .is_some_and(|launch| launch.token.matches(fields.get("token")))
        {
            emit(MetadataEvent::End(event.clone()));
            self.launch = None;
            self.text.clear();
        }
    }

    fn inspect_text(&mut self, data: &str, emit: &mut impl FnMut(MetadataEvent)) {
        // A configured profile or a command mentioned in arbitrary output is not a launch.
        // Claude reports IDs through its launch event and hook instead of output heuristics.
        if !matches!(
            self.launch,
            Some(Launch {
                provider: Provider::Codex,
                ..
            })
        ) {
            return;
        }
        self.text.push_str(data);
        let recent = last_utf16(&self.text, TEXT_UNITS);
        self.text = ANSI.replace_all(recent, "").into_owned();
        let mut found = Vec::new();
        for pattern in CODEX_PATTERNS.iter() {
            for captures in pattern.captures_iter(&self.text) {
                let whole = captures.get(0).expect("match");
                let raw = Map::from_iter([
                    ("provider".to_owned(), Value::from("codex")),
                    ("sessionId".to_owned(), Value::from(&captures[1])),
                    ("cwd".to_owned(), Value::from(self.cwd.as_str())),
                ]);
                if let Some(session) = session_metadata(&Value::Object(raw)) {
                    found.push((whole.start(), whole.end(), session));
                }
            }
        }
        found.sort_by_key(|(start, _, _)| *start);
        let last_end = found.last().map(|(_, end, _)| *end);
        for (_, _, session) in found {
            emit(MetadataEvent::Change(MetadataPatch {
                cwd: None,
                session: Some(Some(session)),
            }));
        }
        if let Some(end) = last_end {
            self.text.drain(..end);
        }
    }
}

/// Finds the first OSC start and its first BEL or ST terminator: (start, payload end, sequence end).
fn find_osc(buffer: &str) -> Option<(usize, usize, usize)> {
    let start = buffer.find("\x1b]")?;
    let bytes = buffer.as_bytes();
    let mut index = start + 2;
    while index < bytes.len() {
        match bytes[index] {
            0x07 => return Some((start, index, index + 1)),
            0x1b if bytes.get(index + 1) == Some(&b'\\') => return Some((start, index, index + 2)),
            _ => index += 1,
        }
    }
    None
}

/// The string `RegExp.prototype.test` sees: JavaScript turns a one-element array into its element.
fn coerced_token(value: Option<&Value>) -> Option<&str> {
    match value? {
        Value::String(token) => Some(token),
        Value::Array(items) if items.len() == 1 => coerced_token(items.first()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_ids_are_uuids_in_either_case() {
        assert!(is_session_id("12345678-1234-4321-9876-123456789ABC"));
        assert!(!is_session_id("12345678-1234-4321-9876-123456789abg"));
        assert!(!is_session_id("123456781234-4321-9876-123456789abcd"));
        assert!(!is_session_id("12345678-1234-4321-9876-123456789abc\n"));
    }

    #[test]
    fn osc_search_takes_the_first_terminator() {
        assert_eq!(find_osc("a\x1b]x\x1b\\y\x07"), Some((1, 4, 6)));
        assert_eq!(find_osc("\x1b]x\x1b]y\x07"), Some((0, 6, 7)));
        assert_eq!(find_osc("\x1b]open"), None);
    }
}
