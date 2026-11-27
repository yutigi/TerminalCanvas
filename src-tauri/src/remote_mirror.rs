//! Bounded, memory-only output for browser attachment. Desktop acknowledgments remain authoritative.

use std::collections::{BTreeMap, HashMap, VecDeque};

use serde_json::{Value, json};
use tc_core::workspace::Workspace;
use tc_pty::manager::TerminalManager;
use tokio::sync::broadcast;

const HISTORY_BYTES: usize = 2 * 1024 * 1024;

struct Output {
    id: String,
    data: String,
    position: u64,
}

pub(crate) struct Mirror {
    board: Option<Workspace>,
    epoch: Option<u64>,
    terminals: Value,
    output: VecDeque<Output>,
    bytes: usize,
    next_output: u64,
    replay_gap: Option<u64>,
}

impl Mirror {
    pub fn new() -> Self {
        Self {
            board: None,
            epoch: None,
            terminals: Value::Null,
            output: VecDeque::new(),
            bytes: 0,
            next_output: 1,
            replay_gap: None,
        }
    }

    pub fn begin_capture(&mut self) -> u64 {
        // Another attachment should retry if the desktop cannot return its screen.
        self.mark_gap(self.next_output - 1);
        self.next_output
    }

    pub fn replay_truncated(&self) -> bool {
        self.replay_gap.is_some()
    }

    /// Replace each captured terminal's old replay without duplicating data received after the capture.
    pub fn seed(&mut self, position: u64, screens: BTreeMap<String, String>) {
        let boundary = self.output.partition_point(|entry| entry.position < position);
        let mut live = self.output.split_off(boundary);
        self.output.retain(|entry| {
            if screens.contains_key(&entry.id) {
                self.bytes -= entry.data.len();
                return false;
            }
            true
        });
        for (id, data) in screens {
            if data.is_empty() {
                continue;
            }
            if data.len() > HISTORY_BYTES - self.bytes {
                self.mark_gap(position);
                continue;
            }
            self.bytes += data.len();
            self.output.push_back(Output {
                id,
                data,
                position: position - 1,
            });
        }
        self.output.append(&mut live);
    }

    pub fn finish_capture(&mut self, position: u64) {
        if self.replay_gap.is_some_and(|gap| gap < position) {
            self.replay_gap = None;
        }
    }

    fn mark_gap(&mut self, position: u64) {
        self.replay_gap = Some(self.replay_gap.unwrap_or(0).max(position));
    }

    pub fn observe(&mut self, event: &Value, events: &broadcast::Sender<Value>) {
        if let Some(id) = event["id"].as_str() {
            if event["type"] == "metadata" && event["initial"] == true {
                self.output.retain(|entry| entry.id != id);
                self.bytes = self.output.iter().map(|entry| entry.data.len()).sum();
            }
            if event["type"] == "data"
                && let Some(data) = event["data"].as_str()
                && !data.is_empty()
            {
                self.bytes += data.len();
                self.output.push_back(Output {
                    id: id.to_owned(),
                    data: data.to_owned(),
                    position: self.next_output,
                });
                self.next_output += 1;
                while self.bytes > HISTORY_BYTES {
                    if let Some(entry) = self.output.pop_front() {
                        self.bytes -= entry.data.len();
                        self.mark_gap(entry.position);
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
                .retain(|entry| board.cards.iter().any(|card| card.id == entry.id));
            self.bytes = self.output.iter().map(|entry| entry.data.len()).sum();
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
        for entry in &self.output {
            output.entry(&entry.id).or_default().push_str(&entry.data);
        }
        json!({ "workspace": board, "terminals": Self::terminals(board, manager), "output": output,
            "replayTruncated": self.replay_truncated() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn screen_is_replayed_before_pending_output_and_shares_its_budget() {
        let mut mirror = Mirror::new();
        let events = broadcast::channel(4).0;
        let position = mirror.begin_capture();
        mirror.observe(&json!({"type":"data", "id":"card", "data":"live"}), &events);
        mirror.seed(
            position,
            [
                ("large".into(), "x".repeat(HISTORY_BYTES)),
                ("card".into(), "screen".into()),
            ]
            .into(),
        );
        assert_eq!(
            mirror
                .output
                .iter()
                .map(|entry| (entry.id.as_str(), entry.data.as_str()))
                .collect::<Vec<_>>(),
            [("card", "screen"), ("card", "live")]
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
            mirror.output.iter().map(|entry| entry.data.len()).sum::<usize>()
        );
        assert!(!mirror.output.is_empty());
        mirror.observe(&json!({"type":"metadata", "id":"card", "initial":true}), &events);
        assert_eq!(mirror.bytes, 0);
        assert!(mirror.output.is_empty());
    }

    #[test]
    fn fresh_capture_restores_evicted_quiet_screens_and_keeps_new_live_output() {
        let mut mirror = Mirror::new();
        let events = broadcast::channel(4).0;
        let position = mirror.begin_capture();
        mirror.seed(position, [("quiet".into(), "old screen".into())].into());
        mirror.observe(
            &json!({"type":"data", "id":"busy", "data":"x".repeat(HISTORY_BYTES)}),
            &events,
        );
        assert!(mirror.replay_truncated());
        assert_eq!(mirror.output.len(), 1);
        let position = mirror.begin_capture();
        mirror.observe(&json!({"type":"data", "id":"busy", "data":"new output"}), &events);
        mirror.seed(
            position,
            [
                ("quiet".into(), "quiet screen".into()),
                ("busy".into(), "busy screen".into()),
            ]
            .into(),
        );
        mirror.finish_capture(position);
        assert!(!mirror.replay_truncated());
        assert_eq!(
            mirror
                .output
                .iter()
                .map(|entry| (entry.id.as_str(), entry.data.as_str()))
                .collect::<Vec<_>>(),
            [
                ("busy", "busy screen"),
                ("quiet", "quiet screen"),
                ("busy", "new output")
            ]
        );
    }
}
