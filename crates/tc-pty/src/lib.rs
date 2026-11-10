//! Terminal Canvas process layer: starting shells in PTYs, shell integration, AI session capture,
//! and directory tracking. A port of `src/terminal-manager.cjs`, `src/terminal-cwd.cjs`, and
//! `src/shell-integration.cjs` (see `docs/rust-migration-plan.md`, Phase 2).

pub mod cwd;
pub mod integration;
#[cfg(windows)]
mod job;
pub mod manager;
pub mod pty;
pub mod shell;

pub use manager::{
    Backend, Config, DirectoryChoice, DirectoryRequest, EventSink, ExitStatus, Process, SessionEvent, SessionKey,
    SpawnRequest, Started, TerminalEvent, TerminalManager,
};
pub use pty::PtyBackend;
