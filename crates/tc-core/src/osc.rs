//! The terminal directory and readiness decoder, from `directoryReports` in `src/terminal-cwd.cjs`.
//!
//! It observes OSC 7 (`file://` URIs), OSC 9;9 (Windows paths), and the integration's
//! `777;tc-ready` marker without changing the PTY bytes. Retained data stays bounded even when a
//! program emits an unterminated or oversized sequence.

use crate::Platform;
use crate::js::utf16_len;
use crate::node;

/// The longest OSC payload kept, in UTF-16 units. Longer payloads are ignored.
const PAYLOAD_UNITS: usize = 16384;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Report {
    /// A reported directory, or `None` when the report was not a usable local path.
    Cwd(Option<String>),
    /// Whether the shell is idle at a prompt.
    Ready(bool),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Text,
    Escape,
    Osc,
    OscEscape,
}

#[derive(Debug, Clone)]
pub struct DirectoryReports {
    platform: Platform,
    hostname: String,
    state: State,
    payload: String,
    payload_units: usize,
    overflow: bool,
}

impl DirectoryReports {
    /// `hostname` is this machine's name: OSC 7 URIs naming it count as local.
    pub fn new(platform: Platform, hostname: &str) -> Self {
        DirectoryReports {
            platform,
            hostname: hostname.to_lowercase(),
            state: State::Text,
            payload: String::new(),
            payload_units: 0,
            overflow: false,
        }
    }

    pub fn feed(&mut self, data: &str, mut emit: impl FnMut(Report)) {
        for c in data.chars() {
            match self.state {
                State::Text => {
                    if c == '\x1b' {
                        self.state = State::Escape;
                    }
                }
                State::Escape => {
                    self.state = match c {
                        ']' => State::Osc,
                        '\x1b' => State::Escape,
                        _ => State::Text,
                    };
                }
                State::Osc => match c {
                    '\x07' => self.finish(&mut emit),
                    '\x1b' => self.state = State::OscEscape,
                    _ if self.payload_units < PAYLOAD_UNITS => {
                        self.payload.push(c);
                        self.payload_units += c.len_utf16();
                    }
                    _ => self.overflow = true,
                },
                State::OscEscape => {
                    if c == '\\' {
                        self.finish(&mut emit);
                    } else {
                        self.state = if c == ']' { State::Osc } else { State::Text };
                        self.clear();
                    }
                }
            }
        }
    }

    fn clear(&mut self) {
        self.payload.clear();
        self.payload_units = 0;
        self.overflow = false;
    }

    fn finish(&mut self, emit: &mut impl FnMut(Report)) {
        if !self.overflow {
            let payload = self.payload.as_str();
            if let Some(flag) = payload
                .strip_prefix("777;tc-ready;")
                .filter(|flag| matches!(*flag, "0" | "1"))
            {
                emit(Report::Ready(flag == "1"));
            } else if let Some(value) = payload.strip_prefix("9;9;") {
                let value = match value.strip_prefix('"').and_then(|v| v.strip_suffix('"')) {
                    Some(inner) => inner,
                    // A lone quote both starts and ends the value.
                    None if value == "\"" => "",
                    None => value,
                };
                emit(Report::Cwd(valid_directory(value, self.platform)));
            } else if let Some(uri) = payload.strip_prefix("7;")
                && let Some(report) = self.file_uri(uri)
            {
                emit(report);
            }
        }
        self.state = State::Text;
        self.clear();
    }

    /// OSC 7. Remote hosts and other schemes produce no report; malformed local URIs report `None`.
    fn file_uri(&self, uri: &str) -> Option<Report> {
        let Some(url) = node::parse_url(uri) else {
            return Some(Report::Cwd(None));
        };
        let windows = self.platform.is_windows();
        let hostname = url.hostname();
        let lowercase = hostname.to_lowercase();
        let local = hostname.is_empty() || lowercase == "localhost" || lowercase == self.hostname;
        if url.protocol() != "file:" || !(local || windows) {
            return None;
        }
        let pathname = url.pathname();
        let directory = if windows && starts_with_localhost(uri) && !starts_with_drive(pathname) {
            // WHATWG URLs erase `localhost`. Keep its UNC meaning for a share path, while
            // file://localhost/C:/... stays a drive path.
            if has_encoded_backslash(pathname) {
                None
            } else {
                node::file_url_to_path(hostname, pathname, false)
                    .map(|path| format!("\\\\localhost{}", path.replace('/', "\\")))
            }
        } else {
            // Windows file authorities remain UNC hosts, even on this machine.
            let hostname = if local && !windows { "" } else { hostname };
            node::file_url_to_path(hostname, pathname, windows)
        };
        Some(Report::Cwd(
            directory.and_then(|directory| valid_directory(&directory, self.platform)),
        ))
    }
}

/// `/^file:\/\/localhost\//i` on the raw URI.
fn starts_with_localhost(uri: &str) -> bool {
    uri.get(..17)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file://localhost/"))
}

/// `/^\/[a-z]:/i` on the pathname.
fn starts_with_drive(pathname: &str) -> bool {
    let bytes = pathname.as_bytes();
    bytes.len() >= 3 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b':'
}

fn has_encoded_backslash(pathname: &str) -> bool {
    pathname
        .as_bytes()
        .windows(3)
        .any(|w| w[0] == b'%' && w[1] == b'5' && w[2] | 0x20 == b'c')
}

/// A directory a terminal may report: at most 4096 UTF-16 units, no C0 control or DEL, and absolute.
pub fn valid_directory(value: &str, platform: Platform) -> Option<String> {
    let usable =
        utf16_len(value) <= 4096 && !value.bytes().any(|b| b < 0x20 || b == 0x7f) && is_absolute(value, platform);
    usable.then(|| value.to_owned())
}

/// Node's `path.win32.isAbsolute` or `path.posix.isAbsolute`.
pub fn is_absolute(value: &str, platform: Platform) -> bool {
    let bytes = value.as_bytes();
    if !platform.is_windows() {
        return bytes.first() == Some(&b'/');
    }
    let separator = |b: u8| b == b'/' || b == b'\\';
    match bytes {
        [] => false,
        [first, ..] if separator(*first) => true,
        [letter, b':', third, ..] => letter.is_ascii_alphabetic() && separator(*third),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reports(platform: Platform, data: &str) -> Vec<Report> {
        let mut out = Vec::new();
        DirectoryReports::new(platform, "TC-Host").feed(data, |r| out.push(r));
        out
    }

    #[test]
    fn windows_absolute_paths() {
        for (path, absolute) in [
            ("C:\\", true),
            ("C:/x", true),
            ("C:", false),
            ("\\x", true),
            ("/x", true),
            ("x", false),
            ("", false),
        ] {
            assert_eq!(is_absolute(path, Platform::Windows), absolute, "{path}");
        }
        assert!(!is_absolute("C:\\", Platform::Linux));
    }

    #[test]
    fn lone_quote_is_an_empty_path() {
        assert_eq!(reports(Platform::Windows, "\x1b]9;9;\"\x07"), [Report::Cwd(None)]);
    }

    #[test]
    fn decodes_drive_and_unix_paths() {
        assert_eq!(
            reports(Platform::Windows, "\x1b]7;file:///C:/a%20b\x07"),
            [Report::Cwd(Some("C:\\a b".into()))]
        );
        assert_eq!(
            reports(Platform::Linux, "\x1b]7;file://tc-host/a\x1b\\"),
            [Report::Cwd(Some("/a".into()))]
        );
        assert!(reports(Platform::Linux, "\x1b]7;file://remote/a\x07").is_empty());
    }
}
