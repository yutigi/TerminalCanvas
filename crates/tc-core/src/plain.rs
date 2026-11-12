//! Terminal output as plain text, for the output logs of terminals that programs open (see
//! [`crate::launch`]). Escape sequences are removed, carriage returns before line feeds are dropped,
//! and cursor moves to another row become line breaks, because Windows ConPTY often redraws lines
//! with cursor positioning instead of line feeds. The decoder keeps its state between chunks, so a
//! sequence split across two reads is still removed.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Text,
    Escape,
    /// `ESC` followed by intermediate bytes, waiting for the final byte.
    EscapeIntermediate,
    Csi,
    /// OSC, DCS, SOS, PM, and APC: a string ended by BEL (OSC only) or `ESC \`.
    String,
    StringEscape,
}

#[derive(Debug, Clone)]
pub struct PlainText {
    state: State,
    /// Whether the current output line has any text yet.
    line_started: bool,
    /// A carriage return waiting to see whether a line feed follows.
    pending_return: bool,
}

impl Default for PlainText {
    fn default() -> Self {
        Self::new()
    }
}

impl PlainText {
    pub fn new() -> Self {
        PlainText {
            state: State::Text,
            line_started: false,
            pending_return: false,
        }
    }

    fn newline(&mut self, out: &mut String) {
        out.push('\n');
        self.line_started = false;
    }

    /// The plain text in `data`, given everything fed before it.
    pub fn feed(&mut self, data: &str) -> String {
        let mut out = String::with_capacity(data.len());
        for c in data.chars() {
            match self.state {
                State::Text => {
                    if self.pending_return && c != '\n' {
                        // A bare carriage return rewrites the line; keep what was written so far
                        // on its own line rather than merging the two.
                        self.pending_return = false;
                        if self.line_started {
                            self.newline(&mut out);
                        }
                    }
                    match c {
                        '\x1b' => self.state = State::Escape,
                        '\r' => self.pending_return = true,
                        '\n' => {
                            self.pending_return = false;
                            self.newline(&mut out);
                        }
                        '\t' => {
                            out.push(c);
                            self.line_started = true;
                        }
                        '\u{9b}' => self.state = State::Csi,
                        '\u{9d}' | '\u{90}' | '\u{98}' | '\u{9e}' | '\u{9f}' => self.state = State::String,
                        c if c.is_control() => {}
                        c => {
                            out.push(c);
                            self.line_started = true;
                        }
                    }
                }
                State::Escape => {
                    self.state = match c {
                        '[' => State::Csi,
                        ']' | 'P' | 'X' | '^' | '_' => State::String,
                        '\x1b' => State::Escape,
                        '\x20'..='\x2f' => State::EscapeIntermediate,
                        // `ESC E` (next line) moves to a new row.
                        'E' => {
                            if self.line_started {
                                self.newline(&mut out);
                            }
                            State::Text
                        }
                        _ => State::Text,
                    };
                }
                State::EscapeIntermediate => {
                    if !('\x20'..='\x2f').contains(&c) {
                        self.state = State::Text;
                    }
                }
                State::Csi => {
                    if ('\x40'..='\x7e').contains(&c) {
                        self.state = State::Text;
                        // Cursor position and vertical moves start a new row.
                        if matches!(c, 'H' | 'f' | 'A' | 'B' | 'E' | 'F' | 'd') && self.line_started {
                            self.newline(&mut out);
                        }
                    } else if c == '\x1b' {
                        self.state = State::Escape;
                    }
                }
                State::String => match c {
                    '\x07' | '\u{9c}' => self.state = State::Text,
                    '\x1b' => self.state = State::StringEscape,
                    _ => {}
                },
                State::StringEscape => {
                    self.state = if c == '\\' { State::Text } else { State::String };
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(chunks: &[&str]) -> String {
        let mut decoder = PlainText::new();
        chunks.iter().map(|chunk| decoder.feed(chunk)).collect()
    }

    #[test]
    fn removes_escape_sequences_even_when_split() {
        assert_eq!(plain(&["\x1b[1;32mgreen\x1b[0m done\r\n"]), "green done\n");
        assert_eq!(
            plain(&["a\x1b[", "38;5;1", "mb\x1b]0;title\x07c\x1b]8;;http://x\x1b\\d\n"]),
            "abcd\n"
        );
        assert_eq!(plain(&["\x1b(Bx\x1b=y\x1bPdcs data\x1b\\z\n"]), "xyz\n");
        assert_eq!(plain(&["tab\there\x08\x00!\n"]), "tab\there!\n");
    }

    #[test]
    fn row_changes_and_bare_returns_become_line_breaks() {
        // ConPTY redraws: text, then a cursor move to the next row instead of a line feed.
        assert_eq!(
            plain(&["PS C:\\> echo hi\x1b[2;1Hhi\x1b[3;1HPS C:\\> "]),
            "PS C:\\> echo hi\nhi\nPS C:\\> "
        );
        assert_eq!(
            plain(&["\x1b[H\x1b[2Jfirst"]),
            "first",
            "a move before any text adds nothing"
        );
        assert_eq!(plain(&["50%\r", "100%\r\n"]), "50%\n100%\n");
        assert_eq!(plain(&["line\r", "\n"]), "line\n", "CR LF split across chunks");
    }
}
