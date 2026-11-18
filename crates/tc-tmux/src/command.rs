//! Commands are built from fixed verbs, typed targets, and individually quoted arguments.

use std::fmt::{self, Write};
use std::str::FromStr;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidArgument(pub &'static str);

impl fmt::Display for InvalidArgument {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for InvalidArgument {}

macro_rules! id {
    ($name:ident, $prefix:literal) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub struct $name(u64);

        impl FromStr for $name {
            type Err = InvalidArgument;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                let digits = value
                    .strip_prefix($prefix)
                    .ok_or(InvalidArgument("Invalid tmux ID."))?;
                if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
                    return Err(InvalidArgument("Invalid tmux ID."));
                }
                digits
                    .parse()
                    .map(Self)
                    .map_err(|_| InvalidArgument("Invalid tmux ID."))
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}{}", $prefix, self.0)
            }
        }
    };
}

id!(PaneId, "%");
id!(WindowId, "@");
id!(SessionId, "$");

/// Conservative names for TC-created sessions/windows. External names should be addressed by ID.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Name(String);

impl Name {
    pub fn new(value: &str) -> Result<Self, InvalidArgument> {
        if value.is_empty()
            || value.len() > 128
            || value.starts_with('-')
            || !value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err(InvalidArgument(
                "Use 1–128 ASCII letters, digits, underscores or hyphens; no leading hyphen.",
            ));
        }
        Ok(Self(value.into()))
    }
}

/// One control-protocol line, never a shell command. Construction cannot introduce new commands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Command(String);

/// tmux single quotes suppress variable expansion. Adjacent double quotes encode a literal quote.
/// This is tmux parser quoting, not permission to pass the result to a system shell.
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

impl Command {
    fn build(verb: &str, args: &[String]) -> Self {
        let mut line = verb.to_owned();
        for arg in args {
            line.push(' ');
            line.push_str(&quote(arg));
        }
        Self(line)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn list_sessions() -> Self {
        Self::build("list-sessions", &["-F".into(), "#{session_id}\t#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{@tc-workspace}".into()])
    }

    pub fn list_windows(session: SessionId) -> Self {
        Self::build(
            "list-windows",
            &[
                "-t".into(),
                session.to_string(),
                "-F".into(),
                "#{window_id}\t#{window_name}\t#{pane_id}\t#{pane_pid}\t#{pane_current_path}\t#{@tc-card}".into(),
            ],
        )
    }

    pub fn new_session(name: &Name) -> Self {
        Self::build("new-session", &["-d".into(), "-s".into(), name.0.clone()])
    }

    pub fn new_window(session: SessionId, name: &Name) -> Self {
        Self::build(
            "new-window",
            &[
                "-d".into(),
                "-t".into(),
                session.to_string(),
                "-n".into(),
                name.0.clone(),
            ],
        )
    }

    /// Send literal bytes only. Even NUL, newlines, semicolons and format strings become hex words.
    /// Kept at the current host's 65,536 UTF-16-unit boundary for later backend integration.
    pub fn send_keys(pane: PaneId, input: &str) -> Result<Self, InvalidArgument> {
        if input.encode_utf16().count() > 65_536 {
            return Err(InvalidArgument("Terminal input exceeds 65,536 UTF-16 units."));
        }
        if input.is_empty() {
            return Err(InvalidArgument("Terminal input is empty."));
        }
        let mut line = format!("send-keys -t {} -H", quote(&pane.to_string()));
        for byte in input.as_bytes() {
            write!(line, " {byte:02x}").expect("writing to a string");
        }
        Ok(Self(line))
    }

    pub fn capture(pane: PaneId, history_lines: u16) -> Self {
        Self::build(
            "capture-pane",
            &[
                "-p".into(),
                "-e".into(),
                "-J".into(),
                "-t".into(),
                pane.to_string(),
                "-S".into(),
                format!("-{history_lines}"),
            ],
        )
    }

    pub fn resize_window(window: WindowId, cols: u16, rows: u16) -> Result<Self, InvalidArgument> {
        if cols == 0 || rows == 0 {
            return Err(InvalidArgument("Terminal dimensions must be positive."));
        }
        Ok(Self::build(
            "resize-window",
            &[
                "-t".into(),
                window.to_string(),
                "-x".into(),
                cols.to_string(),
                "-y".into(),
                rows.to_string(),
            ],
        ))
    }

    pub fn window_size(window: WindowId, cols: u16, rows: u16) -> Result<Self, InvalidArgument> {
        if cols == 0 || rows == 0 {
            return Err(InvalidArgument("Terminal dimensions must be positive."));
        }
        Ok(Self::build(
            "refresh-client",
            &["-C".into(), format!("{window}:{cols}x{rows}")],
        ))
    }

    pub fn pause_after(seconds: u16) -> Self {
        Self::build("refresh-client", &["-f".into(), format!("pause-after={seconds}")])
    }

    /// tmux pause discards pending output; continue starts at the current pane offset.
    /// A backend must resynchronize from capture-pane, not promise lossless byte backpressure.
    pub fn pane_flow(pane: PaneId, pause: bool) -> Self {
        Self::build(
            "refresh-client",
            &[
                "-A".into(),
                format!("{pane}:{}", if pause { "pause" } else { "continue" }),
            ],
        )
    }

    /// Format subscriptions are opt-in; only known formats are exposed by this spike.
    pub fn subscribe_cwd(pane: PaneId) -> Self {
        Self::build(
            "refresh-client",
            &["-B".into(), format!("tc-cwd:{pane}:#{{pane_current_path}}")],
        )
    }

    pub fn detach() -> Self {
        Self::build("detach-client", &[])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_targets_reject_parser_syntax() {
        for name in [
            "",
            "-x",
            "a.b",
            "a:b",
            "a;b",
            "#{pane_id}",
            "$HOME",
            "x\ny",
            "x'y",
            "ไทย",
        ] {
            assert!(Name::new(name).is_err(), "{name:?}");
        }
        assert!(Name::new(&"a".repeat(129)).is_err());
        assert!(Name::new("tc-work_123").is_ok());
        for id in ["1", "%", "%1;kill-server", "%+1", "%18446744073709551616", "%1\n"] {
            assert!(id.parse::<PaneId>().is_err(), "{id}");
        }
        assert!("@1".parse::<PaneId>().is_err());
    }

    #[test]
    fn input_is_only_hex_and_obeys_utf16_limit() {
        let pane = "%12".parse().unwrap();
        assert_eq!(
            Command::send_keys(pane, "\0\r\n;#{}'\\\u{1b}😀").unwrap().as_str(),
            "send-keys -t '%12' -H 00 0d 0a 3b 23 7b 7d 27 5c 1b f0 9f 98 80"
        );
        assert!(Command::send_keys(pane, &"😀".repeat(32_768)).is_ok());
        assert!(Command::send_keys(pane, &"😀".repeat(32_769)).is_err());
        assert!(Command::send_keys(pane, "").is_err());
    }

    #[test]
    fn arguments_are_quoted_individually() {
        assert_eq!(quote("x'; $HOME #{x} \\"), "'x'\"'\"'; $HOME #{x} \\'");
        let name = Name::new("tc-test").unwrap();
        assert_eq!(
            Command::new_window("$2".parse().unwrap(), &name).as_str(),
            "new-window '-d' '-t' '$2' '-n' 'tc-test'"
        );
        assert!(Command::resize_window("@1".parse().unwrap(), 0, 24).is_err());
        assert!(Command::window_size("@1".parse().unwrap(), 80, 0).is_err());
    }
}
