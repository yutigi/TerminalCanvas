//! Bounded, memory-only output for browser attachment. Desktop acknowledgments remain authoritative.

use std::collections::{HashMap, VecDeque};

use serde_json::{Value, json};
use tc_core::workspace::Workspace;
use tc_pty::manager::TerminalManager;
use tokio::sync::broadcast;

const HISTORY_BYTES: usize = 2 * 1024 * 1024;

pub(crate) struct Mirror {
    board: Option<Workspace>,
    epoch: Option<u64>,
    terminals: Value,
    output: VecDeque<(String, String)>,
    bytes: usize,
}

impl Mirror {
    pub fn new() -> Self {
        Self {
            board: None,
            epoch: None,
            terminals: Value::Null,
            output: VecDeque::new(),
            bytes: 0,
        }
    }

    /// Insert complete screens before all PTY data received since capture began.
    pub fn seed(&mut self, screens: impl IntoIterator<Item = (String, String)>) {
        for (id, screen) in screens {
            if !screen.is_empty() && screen.len() <= HISTORY_BYTES - self.bytes {
                self.bytes += screen.len();
                self.output.push_front((id, screen));
            }
        }
    }

    pub fn observe(&mut self, event: &Value, events: &broadcast::Sender<Value>) {
        if let Some(id) = event["id"].as_str() {
            if event["type"] == "metadata" && event["initial"] == true {
                self.output.retain(|(key, _)| key != id);
                self.bytes = self.output.iter().map(|(_, data)| data.len()).sum();
            }
            if event["type"] == "data"
                && let Some(data) = event["data"].as_str()
            {
                self.bytes += data.len();
                self.output.push_back((id.to_owned(), data.to_owned()));
                while self.bytes > HISTORY_BYTES {
                    if let Some((_, data)) = self.output.pop_front() {
                        self.bytes -= data.len();
                    }
                }
            }
        }
        if matches!(
            event["type"].as_str(),
            Some("data" | "exit" | "cwd" | "metadata" | "title")
        ) {
            let _ = events.send(event.clone());
        }
    }

    pub fn sync(
        &mut self,
        board: &Workspace,
        epoch: u64,
        manager: &TerminalManager,
        events: &broadcast::Sender<Value>,
    ) {
        if self.board.as_ref() != Some(board) || self.epoch != Some(epoch) {
            self.output
                .retain(|(id, _)| board.cards.iter().any(|card| &card.id == id));
            self.bytes = self.output.iter().map(|(_, data)| data.len()).sum();
            self.board = Some(board.clone());
            self.epoch = Some(epoch);
            let _ = events.send(json!({ "type": "remote-workspace", "workspace": board, "titleEpoch": epoch }));
        }
        let terminals = Self::terminals(board, manager);
        if self.terminals != terminals {
            self.terminals = terminals;
            let _ = events.send(json!({ "type": "remote-terminals", "terminals": self.terminals }));
        }
    }

    fn terminals(board: &Workspace, manager: &TerminalManager) -> Value {
        json!(
            board
                .cards
                .iter()
                .map(|card| {
                    let view = manager.view(&card.id);
                    json!({ "id": card.id, "running": view.is_some(), "generation": view.map(|v| v.0),
                "cols": view.map_or(80, |v| v.1), "rows": view.map_or(24, |v| v.2) })
                })
                .collect::<Vec<_>>()
        )
    }

    pub fn snapshot(&self, board: &Workspace, manager: &TerminalManager) -> Value {
        let mut output: HashMap<&str, String> = HashMap::new();
        for (id, data) in &self.output {
            output.entry(id).or_default().push_str(data);
        }
        json!({ "workspace": board, "terminals": Self::terminals(board, manager), "output": output })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn screen_is_replayed_before_pending_output_and_shares_its_budget() {
        let mut mirror = Mirror::new();
        let events = broadcast::channel(4).0;
        mirror.observe(&json!({"type":"data", "id":"card", "data":"live"}), &events);
        mirror.seed([
            ("large".into(), "x".repeat(HISTORY_BYTES)),
            ("card".into(), "screen".into()),
        ]);
        assert_eq!(
            mirror.output,
            [("card".into(), "screen".into()), ("card".into(), "live".into())]
        );
        assert_eq!(mirror.bytes, 10);

        mirror.observe(&json!({"type":"metadata", "id":"card", "initial":true}), &events);
        assert!(mirror.output.is_empty());
        assert_eq!(mirror.bytes, 0);
    }

    #[test]
    fn output_replay_is_bounded_and_restart_discards_old_generation() {
        let mut mirror = Mirror::new();
        let events = broadcast::channel(4).0;
        for _ in 0..12 {
            mirror.observe(&json!({"type":"data", "id":"card", "data":"🚀".repeat(65536)}), &events);
        }
        assert!(mirror.bytes <= HISTORY_BYTES);
        assert_eq!(
            mirror.bytes,
            mirror.output.iter().map(|(_, data)| data.len()).sum::<usize>()
        );
        assert!(!mirror.output.is_empty());
        mirror.observe(&json!({"type":"metadata", "id":"card", "initial":true}), &events);
        assert_eq!(mirror.bytes, 0);
        assert!(mirror.output.is_empty());
    }
}
