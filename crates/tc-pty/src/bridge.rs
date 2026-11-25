//! Routes bridge requests on the actor that owns the PTYs. A mailbox and its original parent
//! belong to one run of a card and are dropped with that run.

use std::collections::VecDeque;
use std::path::Path;

use serde::Serialize;
use serde_json::{Value, json};
use tc_core::bridge::{self, MAILBOX_LIMIT, Request, Target};

use super::{SessionKey, TerminalManager};

#[derive(Default)]
pub(super) struct CardBridge {
    parent: Option<SessionKey>,
    messages: VecDeque<Message>,
}

#[derive(Serialize)]
struct Message {
    id: String,
    from: String,
    text: String,
}

impl TerminalManager {
    pub fn session_key(&self, id: &str) -> Option<SessionKey> {
        let session = self.sessions.get(id)?;
        Some(SessionKey {
            id: id.to_owned(),
            generation: session.generation,
        })
    }

    pub fn set_bridge_parent(&mut self, child: &str, parent: SessionKey) {
        if let Some(session) = self.sessions.get_mut(child) {
            session.bridge.parent = Some(parent);
        }
    }

    /// The app inbox can address a running card for PTY input. It has no originating card.
    pub fn poll_app_bridge(&mut self, inbox: &Path) {
        self.poll_bridge(inbox, None);
    }

    pub(super) fn poll_terminal_bridge(&mut self, id: &str) {
        if let Some(inbox) = self
            .sessions
            .get(id)
            .and_then(|session| session.integration.as_ref())
            .and_then(|integration| integration.launch_dir.clone())
        {
            self.poll_bridge(&inbox, Some(id));
        }
    }

    fn poll_bridge(&mut self, inbox: &Path, source: Option<&str>) {
        for (id, request) in bridge::take_requests(inbox) {
            let result = match request {
                Ok(Request::ReceiveMessages) => {
                    if let Some(session) = source.and_then(|id| self.sessions.get_mut(id)) {
                        let result = json!({"status":"received", "messages":session.bridge.messages});
                        if answer(inbox, &id, &result) {
                            session.bridge.messages.clear();
                        }
                        continue;
                    }
                    Err("Receive messages from inside a running Terminal Canvas card.".into())
                }
                Ok(request) => self.deliver_bridge(source, &id, request),
                Err(error) => Err(error.to_string()),
            };
            let result = result.unwrap_or_else(|error| json!({"status":"refused", "error":error}));
            answer(inbox, &id, &result);
        }
    }

    fn deliver_bridge(&mut self, source: Option<&str>, id: &str, request: Request) -> Result<Value, String> {
        match request {
            Request::SendInput {
                target,
                mut text,
                enter,
            } => {
                let card = self.bridge_target(source, target)?;
                if enter {
                    text.push('\r');
                }
                self.write(&card, &text).map_err(|error| error.to_string())?;
                self.pointer_typed(&card);
                Ok(json!({"status":"sent", "card":card}))
            }
            Request::SendMessage { target, text } => {
                let source = source.ok_or("Send messages from inside a running Terminal Canvas card.")?;
                let card = self.bridge_target(Some(source), target)?;
                let session = self.sessions.get_mut(&card).expect("bridge target is running");
                if session
                    .integration
                    .as_ref()
                    .and_then(|i| i.launch_dir.as_ref())
                    .is_none()
                {
                    return Err("Target card cannot receive messages without the Terminal Canvas hook.".into());
                }
                if session.bridge.messages.len() >= MAILBOX_LIMIT {
                    return Err("Target card's mailbox is full. Ask it to receive messages before retrying.".into());
                }
                session.bridge.messages.push_back(Message {
                    id: id.to_owned(),
                    from: source.to_owned(),
                    text,
                });
                Ok(json!({"status":"delivered", "card":card, "message":id}))
            }
            Request::ReceiveMessages => unreachable!("receive requests are handled before delivery"),
        }
    }

    fn bridge_target(&self, source: Option<&str>, target: Target) -> Result<String, String> {
        if let Some(card) = target.card {
            return self
                .is_running(&card)
                .then_some(card)
                .ok_or_else(|| "Target card is not running.".into());
        }
        let parent = source
            .and_then(|id| self.sessions.get(id))
            .and_then(|session| session.bridge.parent.as_ref())
            .ok_or("This card has no running launch parent. Specify the target with --to <card ID>.")?;
        if self.sessions.get(&parent.id).map(|session| session.generation) != Some(parent.generation) {
            return Err("The original parent terminal has stopped or restarted.".into());
        }
        Ok(parent.id.clone())
    }
}

fn answer(inbox: &Path, id: &str, result: &Value) -> bool {
    match bridge::write_result(inbox, id, result) {
        Ok(()) => true,
        Err(error) => {
            eprintln!("Could not answer terminal bridge request {id}: {error}");
            false
        }
    }
}
