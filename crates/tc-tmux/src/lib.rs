//! Phase 1 of issue #35: bounded control-mode transport and pure protocol building blocks.
//!
//! This crate is deliberately not connected to the desktop backend yet. Output remains bytes;
//! consumers must keep one UTF-8/OSC decoder per pane, across output notifications.

pub mod client;
pub mod command;
pub mod parser;

pub use client::{Client, ClientEvent, Options, Version};
pub use command::{Command, Name, PaneId, SessionId, WindowId};
pub use parser::{Event, Parser, ProtocolError, ReplyId};
