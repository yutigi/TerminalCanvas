//! Incremental parser for pipe (`-C`) control mode, before any UTF-8 decoding.

use std::fmt;

use crate::PaneId;

pub const MAX_LINE_BYTES: usize = 1024 * 1024;
pub const MAX_REPLY_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_REPLY_LINES: usize = 16_384;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReplyId {
    pub time: u64,
    pub number: u64,
    pub flags: u64,
}

/// Notification arguments remain lossless bytes, including names, paths and layout strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Notification {
    WindowAdd,
    WindowClose,
    WindowRenamed,
    WindowPaneChanged,
    UnlinkedWindowAdd,
    UnlinkedWindowClose,
    UnlinkedWindowRenamed,
    SessionChanged,
    SessionRenamed,
    SessionWindowChanged,
    SessionsChanged,
    LayoutChange,
    PaneModeChanged,
    Pause,
    Continue,
    SubscriptionChanged,
    ClientSessionChanged,
    ClientDetached,
    Message,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Reply {
        id: ReplyId,
        error: bool,
        lines: Vec<Vec<u8>>,
    },
    Output {
        pane: PaneId,
        age: Option<u64>,
        bytes: Vec<u8>,
    },
    Notification {
        kind: Notification,
        name: String,
        arguments: Vec<u8>,
    },
    Exit(Vec<u8>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolError(pub &'static str);

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for ProtocolError {}

struct Block {
    id: ReplyId,
    lines: Vec<Vec<u8>>,
    bytes: usize,
}

#[derive(Default)]
pub struct Parser {
    line: Vec<u8>,
    block: Option<Block>,
    failed: bool,
}

impl Parser {
    pub fn new() -> Self {
        Self::default()
    }

    /// An error poisons the parser; a client must disconnect rather than guess at framing.
    pub fn feed(&mut self, bytes: &[u8]) -> Result<Vec<Event>, ProtocolError> {
        if self.failed {
            return Err(ProtocolError("Control parser is disconnected after a protocol error."));
        }
        let result = self.feed_inner(bytes);
        if result.is_err() {
            self.failed = true;
            self.line.clear();
            self.block = None;
        }
        result
    }

    fn feed_inner(&mut self, bytes: &[u8]) -> Result<Vec<Event>, ProtocolError> {
        let mut events = Vec::new();
        for &byte in bytes {
            if byte == b'\n' {
                let line = std::mem::take(&mut self.line);
                if let Some(event) = self.record(&line)? {
                    events.push(event);
                }
            } else {
                if self.line.len() >= MAX_LINE_BYTES {
                    return Err(ProtocolError("Control line exceeds the byte limit."));
                }
                self.line.push(byte);
            }
        }
        Ok(events)
    }

    pub fn finish(&self) -> Result<(), ProtocolError> {
        if self.failed || !self.line.is_empty() || self.block.is_some() {
            return Err(ProtocolError("Truncated or malformed control stream."));
        }
        Ok(())
    }

    fn record(&mut self, line: &[u8]) -> Result<Option<Event>, ProtocolError> {
        let (name, args) = split(line);
        if let Some(block) = self.block.as_mut() {
            // capture-pane may return text beginning with %end/%error. Only a marker matching
            // this block's complete ID ends it; other lines remain literal command output.
            if (name == b"%end" || name == b"%error") && reply_id(args).ok() == Some(block.id) {
                let block = self.block.take().expect("active reply");
                return Ok(Some(Event::Reply {
                    id: block.id,
                    error: name == b"%error",
                    lines: block.lines,
                }));
            }
            block.bytes += line.len() + 1;
            if block.bytes > MAX_REPLY_BYTES || block.lines.len() >= MAX_REPLY_LINES {
                return Err(ProtocolError("Control reply exceeds the byte limit."));
            }
            block.lines.push(line.to_vec());
            return Ok(None);
        }
        match name {
            b"%begin" => {
                self.block = Some(Block {
                    id: reply_id(args)?,
                    lines: Vec::new(),
                    bytes: 0,
                });
                Ok(None)
            }
            b"%end" | b"%error" => Err(ProtocolError("Reply terminator without a begin record.")),
            b"%output" | b"%extended-output" => {
                let (pane, rest) = split(args);
                let pane = std::str::from_utf8(pane)
                    .ok()
                    .and_then(|s| s.parse().ok())
                    .ok_or(ProtocolError("Invalid output pane ID."))?;
                let (age, data) = if name == b"%extended-output" {
                    let (age, fields) = split(rest);
                    let data = if let Some(data) = fields.strip_prefix(b": ") {
                        data
                    } else {
                        let start = fields
                            .windows(3)
                            .position(|w| w == b" : ")
                            .ok_or(ProtocolError("Extended output is missing its separator."))?;
                        &fields[start + 3..]
                    };
                    (Some(number(age)?), data)
                } else {
                    (None, rest)
                };
                Ok(Some(Event::Output {
                    pane,
                    age,
                    bytes: unescape(data)?,
                }))
            }
            b"%exit" => Ok(Some(Event::Exit(args.to_vec()))),
            _ => {
                let name = std::str::from_utf8(name).map_err(|_| ProtocolError("Non-ASCII notification name."))?;
                if !name.starts_with('%')
                    || !name[1..].bytes().all(|b| b.is_ascii_lowercase() || b == b'-')
                    || name.len() < 2
                {
                    return Err(ProtocolError("Invalid notification name."));
                }
                Ok(Some(Event::Notification {
                    kind: notification(name),
                    name: name.into(),
                    arguments: args.to_vec(),
                }))
            }
        }
    }
}

fn split(bytes: &[u8]) -> (&[u8], &[u8]) {
    match bytes.iter().position(|&b| b == b' ') {
        Some(index) => (&bytes[..index], &bytes[index + 1..]),
        None => (bytes, &[]),
    }
}

fn number(bytes: &[u8]) -> Result<u64, ProtocolError> {
    if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
        return Err(ProtocolError("Invalid control record number."));
    }
    std::str::from_utf8(bytes)
        .ok()
        .and_then(|s| s.parse().ok())
        .ok_or(ProtocolError("Control record number overflow."))
}

fn reply_id(bytes: &[u8]) -> Result<ReplyId, ProtocolError> {
    let fields: Vec<_> = bytes.split(|&b| b == b' ').collect();
    if fields.len() != 3 {
        return Err(ProtocolError("Reply marker must have three numbers."));
    }
    Ok(ReplyId {
        time: number(fields[0])?,
        number: number(fields[1])?,
        flags: number(fields[2])?,
    })
}

/// tmux escapes bytes below 32 and backslashes with exactly three octal digits. Raw non-ASCII
/// bytes also pass through, so UTF-8 must be decoded after unescaping and across notifications.
pub fn unescape(bytes: &[u8]) -> Result<Vec<u8>, ProtocolError> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\\' {
            let digits = bytes
                .get(index + 1..index + 4)
                .ok_or(ProtocolError("Truncated octal escape."))?;
            if !digits.iter().all(|b| (b'0'..=b'7').contains(b)) || digits[0] > b'3' {
                return Err(ProtocolError("Invalid octal byte escape."));
            }
            out.push((digits[0] - b'0') * 64 + (digits[1] - b'0') * 8 + (digits[2] - b'0'));
            index += 4;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    Ok(out)
}

fn notification(name: &str) -> Notification {
    use Notification::*;
    match name {
        "%window-add" => WindowAdd,
        "%window-close" => WindowClose,
        "%window-renamed" => WindowRenamed,
        "%window-pane-changed" => WindowPaneChanged,
        "%unlinked-window-add" => UnlinkedWindowAdd,
        "%unlinked-window-close" => UnlinkedWindowClose,
        "%unlinked-window-renamed" => UnlinkedWindowRenamed,
        "%session-changed" => SessionChanged,
        "%session-renamed" => SessionRenamed,
        "%session-window-changed" => SessionWindowChanged,
        "%sessions-changed" => SessionsChanged,
        "%layout-change" => LayoutChange,
        "%pane-mode-changed" => PaneModeChanged,
        "%pause" => Pause,
        "%continue" => Continue,
        "%subscription-changed" => SubscriptionChanged,
        "%client-session-changed" => ClientSessionChanged,
        "%client-detached" => ClientDetached,
        "%message" => Message,
        _ => Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_chunk_boundary_and_reply_content_are_lossless() {
        let wire = b"%begin 123 7 1\n%output this is reply text\n\n%end 123 7 1\n%output %1 \\033]7;file:///tmp\\007\\360\\237\n%extended-output %1 12 future : \\230\\200\\134\\000\n%exit detached\n";
        let expected = Parser::new().feed(wire).unwrap();
        for boundary in 0..=wire.len() {
            let mut parser = Parser::new();
            let mut got = parser.feed(&wire[..boundary]).unwrap();
            got.extend(parser.feed(&wire[boundary..]).unwrap());
            parser.finish().unwrap();
            assert_eq!(got, expected, "boundary {boundary}");
        }
        assert!(
            matches!(&expected[0], Event::Reply { lines, .. } if lines == &[b"%output this is reply text".to_vec(), vec![]])
        );
        let bytes: Vec<u8> = expected
            .iter()
            .filter_map(|e| match e {
                Event::Output { bytes, .. } => Some(bytes.clone()),
                _ => None,
            })
            .flatten()
            .collect();
        assert_eq!(bytes, b"\x1b]7;file:///tmp\x07\xf0\x9f\x98\x80\\\0");
    }

    #[test]
    fn every_notification_and_unknown_extensions_are_preserved() {
        let names = [
            "window-add",
            "window-close",
            "window-renamed",
            "window-pane-changed",
            "unlinked-window-add",
            "unlinked-window-close",
            "unlinked-window-renamed",
            "session-changed",
            "session-renamed",
            "session-window-changed",
            "sessions-changed",
            "layout-change",
            "pane-mode-changed",
            "pause",
            "continue",
            "subscription-changed",
            "client-session-changed",
            "client-detached",
            "message",
        ];
        for name in names {
            let events = Parser::new()
                .feed(format!("%{name} arbitrary ไทย arguments\n").as_bytes())
                .unwrap();
            assert!(
                matches!(&events[0], Event::Notification { kind, arguments, .. } if *kind != Notification::Unknown && arguments == "arbitrary ไทย arguments".as_bytes())
            );
        }
        assert!(matches!(
            &Parser::new().feed(b"%future-notification x\n").unwrap()[0],
            Event::Notification {
                kind: Notification::Unknown,
                ..
            }
        ));
    }

    #[test]
    fn interleaved_panes_preserve_raw_split_utf8_and_synchronous_reply_text() {
        let events = Parser::new().feed(b"%output %1 \xf0\x9f\n%output %2 other pane\n%output %1 \x98\x80\n%begin 1 2 1\n%pause %1\n%end 1 2 1\n").unwrap();
        let pane1: Vec<u8> = events
            .iter()
            .filter_map(|event| match event {
                Event::Output { pane, bytes, .. } if pane.to_string() == "%1" => Some(bytes.as_slice()),
                _ => None,
            })
            .flatten()
            .copied()
            .collect();
        assert_eq!(std::str::from_utf8(&pane1).unwrap(), "😀");
        assert!(matches!(&events[3], Event::Reply { lines, .. } if lines == &[b"%pause %1".to_vec()]));
    }

    #[test]
    fn error_replies_and_malformed_streams() {
        assert!(matches!(
            &Parser::new().feed(b"%begin 1 2 1\nerror text\n%error 1 2 1\n").unwrap()[0],
            Event::Reply { error: true, .. }
        ));
        for wire in [
            b"%end 1 2 1\n".as_slice(),
            b"%begin 1 2\n",
            b"%output %x data\n",
            b"%output %1 \\400\n",
            b"%output %1 \\08x\n",
            b"%output %1 \\1\n",
            b"%extended-output %1 2 missing\n",
            b"garbage\n",
        ] {
            let mut parser = Parser::new();
            assert!(parser.feed(wire).is_err(), "{wire:?}");
            assert!(parser.feed(b"%exit\n").is_err());
        }
        for wire in [
            b"%begin 1 2 1\n".as_slice(),
            b"%begin 1 2 1\n%end 1 3 1\n",
            b"%output %1 x",
        ] {
            let mut parser = Parser::new();
            parser.feed(wire).unwrap();
            assert!(parser.finish().is_err());
        }
    }

    #[test]
    fn all_256_bytes_round_trip() {
        let wire: String = (0..=255).map(|b| format!("\\{b:03o}")).collect();
        assert_eq!(unescape(wire.as_bytes()).unwrap(), (0..=255).collect::<Vec<u8>>());
    }

    #[test]
    fn captured_text_cannot_end_a_different_reply() {
        let events = Parser::new()
            .feed(b"%begin 1 2 1\n%end 1 3 1\n%error is literal text\n%end 1 2 1\n")
            .unwrap();
        assert!(
            matches!(&events[0], Event::Reply { lines, error: false, .. } if lines == &[b"%end 1 3 1".to_vec(), b"%error is literal text".to_vec()])
        );
    }

    #[test]
    fn line_and_reply_memory_are_bounded() {
        let mut parser = Parser::new();
        assert!(parser.feed(&vec![b'x'; MAX_LINE_BYTES + 1]).is_err());
        let mut parser = Parser::new();
        parser.feed(b"%begin 1 2 1\n").unwrap();
        let line = [vec![b'x'; MAX_LINE_BYTES], vec![b'\n']].concat();
        for _ in 0..7 {
            parser.feed(&line).unwrap();
        }
        assert!(parser.feed(&line).is_err());
        let mut parser = Parser::new();
        parser.feed(b"%begin 1 2 1\n").unwrap();
        assert!(parser.feed(&vec![b'\n'; MAX_REPLY_LINES + 1]).is_err());
    }
}
