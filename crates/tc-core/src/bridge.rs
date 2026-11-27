//! Local bridge requests share the launch inboxes, with a distinct extension so older hosts
//! leave the requests alone and older launch clients keep their existing protocol.

use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::atomic::{self, Access};
use crate::launch;
use crate::{Error, Result};

pub const TEXT_UNITS: usize = 8192;
pub const REQUEST_BYTES: u64 = 64 * 1024;
pub const MAILBOX_LIMIT: usize = 16;
const EXTENSION: &str = "bridge";

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case", tag = "op")]
pub enum Request {
    SendInput { target: Target, text: String, enter: bool },
    SendMessage { target: Target, text: String },
    ReceiveMessages,
}

/// A missing card addresses the original parent of the requesting card.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub card: Option<String>,
}

impl Request {
    pub fn validate(&self) -> Result<()> {
        let (target, text) = match self {
            Self::SendInput { target, text, enter } if *enter || !text.is_empty() => (target, text),
            Self::SendMessage { target, text } if !crate::js::trim(text).is_empty() => (target, text),
            Self::ReceiveMessages => return Ok(()),
            _ => return Err(Error::Invalid("No text was supplied.".into())),
        };
        if target.card.as_deref().is_some_and(|card| !launch::is_card_id(card)) {
            return Err(Error::Invalid("Invalid target card ID.".into()));
        }
        if crate::js::utf16_len(text) > TEXT_UNITS {
            return Err(Error::Invalid(format!("Text exceeds {TEXT_UNITS} UTF-16 units.")));
        }
        Ok(())
    }
}

pub fn write_request(inbox: &Path, request: &Request) -> io::Result<(String, PathBuf)> {
    launch::write_inbox_request(inbox, EXTENSION, request)
}

pub fn result_path(inbox: &Path, id: &str) -> PathBuf {
    inbox.join(format!("{id}.bridge-result"))
}

pub fn write_result(inbox: &Path, id: &str, result: &Value) -> io::Result<()> {
    if !launch::is_request_id(id) {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    atomic::write(&result_path(inbox, id), &serde_json::to_vec(result)?, Access::Private)
}

pub fn take_requests(inbox: &Path) -> impl Iterator<Item = (String, Result<Request>)> {
    launch::take_inbox_requests(inbox, EXTENSION, |file| {
        let invalid = || Error::Invalid("Invalid terminal bridge request.".into());
        let mut bytes = Vec::new();
        File::open(file)?.take(REQUEST_BYTES + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > REQUEST_BYTES {
            return Err(invalid());
        }
        let request: Request = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        request.validate()?;
        Ok(request)
    })
    .filter_map(|(id, request)| Some((id?, request)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_validates_text_and_card_ids() {
        let message = |card: &str, text| Request::SendMessage {
            target: Target {
                card: Some(card.into()),
            },
            text,
        };
        assert!(message("parent_1", "😀".repeat(TEXT_UNITS / 2)).validate().is_ok());
        assert!(message("parent_1", "😀".repeat(TEXT_UNITS / 2 + 1)).validate().is_err());
        assert!(message("../parent", "hello".into()).validate().is_err());
        assert!(message("parent", "\n\t".into()).validate().is_err());
        let enter_only = Request::SendInput {
            target: Target { card: None },
            text: String::new(),
            enter: true,
        };
        assert!(enter_only.validate().is_ok());
    }
}
