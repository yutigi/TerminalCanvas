//! Minimal terminal response for UI-free ConPTY fixtures. The real renderer uses xterm.

pub const POSITION: &str = "\x1b[1;1R";

#[derive(Default)]
pub struct CursorQuery {
    matched: usize,
}

impl CursorQuery {
    /// Counts cursor-position requests, including requests split across output reads.
    pub fn feed(&mut self, text: &str) -> usize {
        const QUERY: &[u8] = b"\x1b[6n";
        let mut requests = 0;
        for byte in text.bytes() {
            if byte == QUERY[self.matched] {
                self.matched += 1;
                if self.matched == QUERY.len() {
                    self.matched = 0;
                    requests += 1;
                }
            } else {
                self.matched = usize::from(byte == QUERY[0]);
            }
        }
        requests
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn responds_to_cursor_queries_at_every_output_split() {
        let text = "prompt\x1b[6n\x1b[6n";
        for split in 0..=text.len() {
            let mut query = CursorQuery::default();
            assert_eq!(query.feed(&text[..split]) + query.feed(&text[split..]), 2);
        }
        assert_eq!(POSITION, "\x1b[1;1R");
    }

    #[test]
    fn ignores_other_controls_and_recovers_from_partial_queries() {
        let mut query = CursorQuery::default();
        assert_eq!(query.feed("\x1b[0n\x1b[6m\x1b[\x1b[6n"), 1);
        assert_eq!(query.feed("ordinary output"), 0);
    }
}
