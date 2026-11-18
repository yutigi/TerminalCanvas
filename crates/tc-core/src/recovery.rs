//! Session recovery state, from `src/workspace-recovery.cjs`.
//!
//! Directories and AI sessions the host observes are authoritative over the renderer's debounced
//! autosaves, so a stale snapshot can never undo them. The host owns persistence: methods that
//! change the board return the board to save, and the host queues the write.

use std::collections::HashMap;

use serde_json::Value;

use crate::Result;
use crate::session::SessionMetadata;
use crate::workspace::{Card, Workspace, create_workspace, validate_card, validate_workspace};

/// What the host last observed for a running card.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardMetadata {
    pub cwd: String,
    pub session: Option<SessionMetadata>,
}

#[derive(Debug, Clone)]
pub struct WorkspaceRecovery {
    epoch: u64,
    board: Workspace,
    metadata: HashMap<String, CardMetadata>,
    titles: HashMap<String, Card>,
}

impl Default for WorkspaceRecovery {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkspaceRecovery {
    pub fn new() -> Self {
        WorkspaceRecovery {
            epoch: 0,
            board: create_workspace(),
            metadata: HashMap::new(),
            titles: HashMap::new(),
        }
    }

    pub fn board(&self) -> &Workspace {
        &self.board
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    /// Starts over with `board`, forgetting observed metadata.
    pub fn reset(&mut self, board: Workspace) {
        self.epoch = self.epoch.wrapping_add(1);
        self.board = board;
        self.metadata.clear();
        self.titles.clear();
    }

    /// Validates a renderer snapshot and applies observed metadata to it, without keeping it.
    pub fn merge(&self, raw: &Value) -> Result<Workspace> {
        let mut board = validate_workspace(raw)?;
        for card in &mut board.cards {
            if let Some(named) = self.titles.get(&card.id) {
                card.title.clone_from(&named.title);
                card.title_mode = named.title_mode;
                card.title_revision = named.title_revision;
            }
            if let Some(metadata) = self.metadata.get(&card.id) {
                card.cwd.clone_from(&metadata.cwd);
                if metadata.session.is_some() {
                    card.session.clone_from(&metadata.session);
                }
            }
        }
        Ok(board)
    }

    /// Merges a renderer snapshot and keeps it as the current board.
    pub fn accept(&mut self, raw: &Value) -> Result<&Workspace> {
        self.board = self.merge(raw)?;
        self.titles
            .retain(|id, _| self.board.cards.iter().any(|card| &card.id == id));
        Ok(&self.board)
    }

    /// The actor is the sole writer of naming decisions. Stale renderer saves cannot undo them.
    pub fn rename(&mut self, id: &str, mode: crate::titles::TitleMode, title: Option<&str>) -> Result<Card> {
        let card = self
            .board
            .cards
            .iter_mut()
            .find(|card| card.id == id)
            .ok_or_else(|| crate::Error::Invalid("This terminal has closed.".into()))?;
        let title = match mode {
            crate::titles::TitleMode::Manual => crate::titles::valid_title(title.unwrap_or_default())
                .ok_or_else(|| crate::Error::Invalid("Use a name of 1 to 100 characters without controls.".into()))?,
            crate::titles::TitleMode::Automatic => title
                .and_then(crate::titles::valid_title)
                .unwrap_or_else(|| crate::titles::fallback(card)),
        };
        card.title = title;
        card.title_mode = Some(mode);
        card.title_revision = card.title_revision.saturating_add(1).min(9_007_199_254_740_991);
        let card = card.clone();
        self.titles.insert(id.to_owned(), card.clone());
        Ok(card)
    }

    /// Adds a card that is starting, unless the board already has it, and returns the board's copy.
    pub fn remember_card(&mut self, raw: &Value) -> Result<Card> {
        let card = validate_card(raw, crate::workspace::VERSION)?;
        if !self.board.cards.iter().any(|existing| existing.id == card.id) {
            let mut next = self.board.clone();
            next.cards.push(card.clone());
            // A caller starting a card before its first layout autosave assigns it to the
            // active canvas. Normal starts already saved their explicit ownership.
            if let Some(canvas) = next
                .canvases
                .iter_mut()
                .find(|canvas| Some(&canvas.id) == next.active_canvas.as_ref())
            {
                canvas.card_ids.push(card.id.clone());
            }
            self.accept(&next.to_value())?;
        }
        Ok(self
            .board
            .cards
            .iter()
            .find(|existing| existing.id == card.id)
            .cloned()
            .unwrap_or(card))
    }

    /// Records what the host observed for a card. Returns the board to save right away, or `None`
    /// when the card is not on the board (it was deleted, or the workspace was replaced).
    pub fn update(&mut self, id: &str, metadata: CardMetadata) -> Result<Option<Workspace>> {
        if !self.board.cards.iter().any(|card| card.id == id) {
            return Ok(None);
        }
        self.metadata.insert(id.to_owned(), metadata);
        let current = self.board.to_value();
        Ok(Some(self.accept(&current)?.clone()))
    }

    /// Accepts `raw` (or the current board) and returns the board to save.
    pub fn persist(&mut self, raw: Option<&Value>) -> Result<Workspace> {
        let raw = raw.cloned().unwrap_or_else(|| self.board.to_value());
        Ok(self.accept(&raw)?.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::Provider;
    use crate::workspace::create_card;
    use serde_json::json;

    #[test]
    fn naming_decisions_survive_stale_autosaves_export_and_metadata_recovery() {
        use crate::titles::TitleMode;
        let mut recovery = WorkspaceRecovery::new();
        let card = create_card(&json!({ "titleMode": "automatic", "cwd": "/repo" })).unwrap();
        recovery.remember_card(&json!(card)).unwrap();
        let stale = recovery.board().to_value();
        let named = recovery
            .rename(&card.id, TitleMode::Automatic, Some("Fix session titles"))
            .unwrap();
        assert_eq!(named.title_revision, 1);
        recovery.persist(Some(&stale)).unwrap();
        assert_eq!(recovery.board().cards[0].title, "Fix session titles");
        recovery
            .rename(&card.id, TitleMode::Manual, Some("My chosen name"))
            .unwrap();
        recovery
            .update(
                &card.id,
                CardMetadata {
                    cwd: "/other".into(),
                    session: Some(session()),
                },
            )
            .unwrap();
        let saved = recovery.persist(Some(&stale)).unwrap();
        assert_eq!(saved.cards[0].title, "My chosen name");
        assert_eq!(saved.cards[0].title_mode, Some(TitleMode::Manual));
        assert_eq!(saved.cards[0].title_revision, 2);
        let exported: Value = serde_json::from_str(&saved.to_file_string(None)).unwrap();
        let reopened = validate_workspace(&exported).unwrap();
        assert_eq!(reopened, saved);
        let previous_epoch = recovery.epoch();
        recovery.reset(reopened);
        assert_ne!(recovery.epoch(), previous_epoch);
        let automatic = recovery.rename(&card.id, TitleMode::Automatic, None).unwrap();
        assert_eq!(automatic.title, "other · Terminal");
        recovery.accept(&create_workspace().to_value()).unwrap();
        assert!(recovery.rename(&card.id, TitleMode::Manual, Some("late")).is_err());
    }

    fn session() -> SessionMetadata {
        SessionMetadata {
            provider: Provider::Claude,
            session_id: "12345678-1234-4321-9876-123456789abc".into(),
            cwd: "/project".into(),
        }
    }

    #[test]
    fn host_metadata_survives_stale_renderer_snapshots() {
        let mut recovery = WorkspaceRecovery::new();
        let mut board = create_workspace();
        board.cards.push(create_card(&json!({})).unwrap());
        let id = board.cards[0].id.clone();
        recovery.reset(board.clone());
        let saved = recovery
            .update(
                &id,
                CardMetadata {
                    cwd: "/latest".into(),
                    session: Some(session()),
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(saved.cards[0].cwd, "/latest");
        let mut stale = board.to_value();
        stale["cards"][0]["x"] = json!(900);
        let saved = recovery.persist(Some(&stale)).unwrap();
        assert_eq!(saved.cards[0].x, 900.0);
        assert_eq!(saved.cards[0].cwd, "/latest");
        assert_eq!(saved.cards[0].session, Some(session()));
        let reopened = validate_workspace(&serde_json::from_str(&saved.to_file_string(None)).unwrap()).unwrap();
        assert_eq!(reopened.cards[0].session, Some(session()));
    }

    #[test]
    fn replaced_workspaces_and_deleted_cards_ignore_late_metadata() {
        let mut recovery = WorkspaceRecovery::new();
        let card = create_card(&json!({})).unwrap();
        let mut board = create_workspace();
        board.cards.push(card.clone());
        recovery.reset(board);
        recovery.reset(create_workspace());
        assert!(
            recovery
                .update(
                    &card.id,
                    CardMetadata {
                        cwd: "/wrong".into(),
                        session: None
                    }
                )
                .unwrap()
                .is_none()
        );
        assert!(recovery.persist(None).unwrap().cards.is_empty());
    }

    #[test]
    fn remembered_cards_join_the_board_once_and_keep_observed_metadata() {
        let mut recovery = WorkspaceRecovery::new();
        let card = create_card(&json!({ "cwd": "/start" })).unwrap();
        let raw = serde_json::to_value(&card).unwrap();
        assert_eq!(recovery.remember_card(&raw).unwrap().cwd, "/start");
        recovery
            .update(
                &card.id,
                CardMetadata {
                    cwd: "/moved".into(),
                    session: None,
                },
            )
            .unwrap();
        assert_eq!(recovery.remember_card(&raw).unwrap().cwd, "/moved");
        assert_eq!(recovery.board().cards.len(), 1);
        for _ in 0..31 {
            let extra = json!(create_card(&json!({})).unwrap());
            recovery.remember_card(&extra).unwrap();
        }
        assert_eq!(recovery.board().cards.len(), 32);
        assert_eq!(recovery.remember_card(&raw).unwrap().cwd, "/moved");
        assert_eq!(recovery.persist(None).unwrap().cards.len(), 32);
    }
}
