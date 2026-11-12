//! Terminal output as plain text, for the output logs of terminals that programs open (see
//! [`crate::launch`]). Escape sequences are removed, carriage returns before line feeds are dropped,
//! and cursor moves to another row become line breaks, because Windows ConPTY often redraws lines
//! with cursor positioning instead of line feeds. Within a row, the decoder follows the cursor:
//! backspaces, bare carriage returns, horizontal moves, and erases rewrite the row the way a terminal
//! would, so shell line editors that redraw what they echo (zsh prints `e`, a backspace, then the
//! whole highlighted line) leave the redrawn text, not both. The log is written as output arrives,
//! so a rewrite of text already written starts a new line instead. The decoder keeps its state
//! between chunks, so a sequence split across two reads is still removed.

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

/// The longest CSI parameter string kept; longer ones are not cursor commands worth following.
const PARAMS: usize = 32;
/// The widest row followed; cursor moves are clamped to it.
const COLUMNS: usize = 4096;
/// The longest row kept before it is written out as a line of its own.
const ROW_LIMIT: usize = 64 * 1024;

#[derive(Debug, Clone)]
pub struct PlainText {
    state: State,
    /// The CSI parameter bytes seen so far.
    params: String,
    /// The current row, as a terminal would show it.
    line: Vec<char>,
    /// The cursor's column in `line`.
    col: usize,
    /// How much of `line` is already written out.
    written: usize,
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
            params: String::new(),
            line: Vec::new(),
            col: 0,
            written: 0,
            pending_return: false,
        }
    }

    /// The row's length without trailing spaces: those are written only once text follows them.
    fn visible(&self) -> usize {
        self.line.iter().rposition(|c| *c != ' ').map_or(0, |last| last + 1)
    }

    /// Writes what is new in the row.
    fn flush(&mut self, out: &mut String) {
        let visible = self.visible();
        if visible > self.written {
            out.extend(&self.line[self.written..visible]);
            self.written = visible;
        }
    }

    /// Ends the row, if it has any text.
    fn newline(&mut self, out: &mut String) {
        self.flush(out);
        if self.written > 0 {
            out.push('\n');
        }
        self.line.clear();
        self.col = 0;
        self.written = 0;
    }

    /// About to change column `index`: text already written cannot be taken back, so a change there
    /// continues the row on a new line, rewritten in full.
    fn touch(&mut self, index: usize, out: &mut String) {
        if index < self.written {
            out.push('\n');
            self.written = 0;
        }
    }

    fn put(&mut self, c: char, out: &mut String) {
        // Output with no line breaks at all still reaches the log in bounded rows.
        if self.col >= ROW_LIMIT && self.col >= self.line.len() {
            self.newline(out);
        }
        self.touch(self.col, out);
        if self.col < self.line.len() {
            self.line[self.col] = c;
        } else {
            self.line.resize(self.col, ' ');
            self.line.push(c);
        }
        self.col += 1;
    }

    /// Blanks columns `from..to` of the row.
    fn erase(&mut self, from: usize, to: usize, out: &mut String) {
        let to = to.min(self.line.len());
        if from >= to || self.line[from..to].iter().all(|c| *c == ' ') {
            return;
        }
        self.touch(from, out);
        if to == self.line.len() {
            self.line.truncate(from);
        } else {
            self.line[from..to].fill(' ');
        }
    }

    /// Follows the CSI sequence ending in `end`, with the parameters collected in `self.params`.
    fn csi(&mut self, end: char, out: &mut String) {
        // Private sequences (`?2004h`) and sub-parameters are not cursor commands.
        if self.params.starts_with(['?', '<', '=', '>']) {
            return;
        }
        let first = self.params.split(';').next().unwrap_or("");
        let n = first.parse::<usize>().unwrap_or(0).min(COLUMNS);
        let count = n.max(1);
        match end {
            // Cursor position and vertical moves start a new row.
            'H' | 'f' | 'A' | 'B' | 'E' | 'F' | 'd' => self.newline(out),
            'C' => self.col = (self.col + count).min(COLUMNS),
            'D' => self.col = self.col.saturating_sub(count),
            'G' | '`' => self.col = count - 1,
            // Erase in line, and erase in display (which also erases the rest of this row).
            'K' | 'J' => match n {
                0 => self.erase(self.col, usize::MAX, out),
                1 => self.erase(0, self.col + 1, out),
                _ => self.erase(0, usize::MAX, out),
            },
            'X' => self.erase(self.col, self.col + count, out),
            'P' => {
                let from = self.col.min(self.line.len());
                let to = (self.col + count).min(self.line.len());
                if from < to {
                    self.touch(from, out);
                    self.line.drain(from..to);
                }
            }
            _ => {}
        }
    }

    /// The plain text in `data`, given everything fed before it.
    pub fn feed(&mut self, data: &str) -> String {
        let mut out = String::with_capacity(data.len());
        for c in data.chars() {
            match self.state {
                State::Text => {
                    if self.pending_return && c != '\n' {
                        // A bare carriage return goes back to the start of the row.
                        self.pending_return = false;
                        self.col = 0;
                    }
                    match c {
                        '\x1b' => self.state = State::Escape,
                        '\r' => self.pending_return = true,
                        '\n' => {
                            self.pending_return = false;
                            self.newline(&mut out);
                        }
                        '\x08' => self.col = self.col.saturating_sub(1),
                        '\t' => self.put(c, &mut out),
                        '\u{9b}' => {
                            self.params.clear();
                            self.state = State::Csi;
                        }
                        '\u{9d}' | '\u{90}' | '\u{98}' | '\u{9e}' | '\u{9f}' => self.state = State::String,
                        c if c.is_control() => {}
                        c => self.put(c, &mut out),
                    }
                }
                State::Escape => {
                    self.state = match c {
                        '[' => {
                            self.params.clear();
                            State::Csi
                        }
                        ']' | 'P' | 'X' | '^' | '_' => State::String,
                        '\x1b' => State::Escape,
                        '\x20'..='\x2f' => State::EscapeIntermediate,
                        // `ESC E` (next line) moves to a new row.
                        'E' => {
                            self.newline(&mut out);
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
                        self.csi(c, &mut out);
                    } else if c == '\x1b' {
                        self.state = State::Escape;
                    } else if self.params.len() < PARAMS {
                        self.params.push(c);
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
        self.flush(&mut out);
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
        assert_eq!(plain(&["tab\there\x07\x00!\n"]), "tab\there!\n");
    }

    #[test]
    fn row_changes_and_bare_returns_become_line_breaks() {
        // ConPTY redraws: text, then a cursor move to the next row instead of a line feed.
        assert_eq!(
            plain(&["PS C:\\> echo hi\x1b[2;1Hhi\x1b[3;1HPS C:\\> x"]),
            "PS C:\\> echo hi\nhi\nPS C:\\> x"
        );
        assert_eq!(
            plain(&["prompt> "]),
            "prompt>",
            "trailing spaces wait for text after them"
        );
        assert_eq!(
            plain(&["\x1b[H\x1b[2Jfirst"]),
            "first",
            "a move before any text adds nothing"
        );
        assert_eq!(
            plain(&["50%\r", "100%\r\n"]),
            "50%\n100%\n",
            "rewriting text already written starts a new line"
        );
        assert_eq!(
            plain(&["50%\r100%\r\n"]),
            "100%\n",
            "within one read, the row is rewritten"
        );
        assert_eq!(plain(&["line\r", "\n"]), "line\n", "CR LF split across chunks");
    }

    #[test]
    fn line_editor_redraws_leave_the_redrawn_row() {
        // zsh with type-ahead: PROMPT_SP's `%` and padding, then ZLE echoes `e`, backs over it, and
        // redraws the whole line.
        let zsh = "\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m        \r \r\r\x1b[0m\x1b[27m\x1b[24m\x1b[Jme % \x1b[K\x1b[?2004he\x08echo hi; exit 0\x1b[?2004l\r\r\nhi\r\n";
        assert_eq!(plain(&[zsh]), "me % echo hi; exit 0\nhi\n");
        assert_eq!(
            plain(&["abc\x08\x08X\n"]),
            "aXc\n",
            "backspace moves, then text overwrites"
        );
        assert_eq!(
            plain(&["abcdef\x1b[3D\x1b[K!\n"]),
            "abc!\n",
            "move left and erase to the end"
        );
        assert_eq!(
            plain(&["ab\x1b[3Cc\x1b[1Gz\n"]),
            "zb   c\n",
            "move right pads; G is absolute"
        );
        assert_eq!(plain(&["abcd\x1b[2D\x1b[P\n"]), "abd\n", "delete characters");
        assert_eq!(
            plain(&["abcd\x1b[2D\x1b[?25l\x1b[2X\n"]),
            "ab\n",
            "private sequences are ignored"
        );
        // Across reads, a redraw of text already written continues on a new line.
        assert_eq!(plain(&["me % e", "\x08echo hi\r\n"]), "me % e\nme % echo hi\n");
    }

    #[test]
    fn rows_without_line_breaks_stay_bounded() {
        let text = plain(&[&"x".repeat(ROW_LIMIT + 10)]);
        assert_eq!(text.lines().map(str::len).collect::<Vec<_>>(), [ROW_LIMIT, 10]);
    }
}
