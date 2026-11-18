# ADR: Embed an authenticated loopback browser server

**Status:** Accepted for phase one
**Date:** 2026-11-18
**Deciders:** Repository owner, with implementation scope confirmed in the task conversation

## Context

Issue #39 requests browser access over LAN/VPN and mobile Safari. The desktop currently has one
host actor, one renderer event channel, per-terminal IPC input sequences, and desktop-owned
workspace recovery. Calling desktop initialization from another client would reset recovery and
input sequencing. Multiple renderers acknowledging output would also defeat PTY backpressure.

## Decision

Embed axum's HTTP/WebSocket server in `src-tauri`, opt-in from the authorized main webview only.
Phase one binds exclusively to `127.0.0.1` with a configurable port. Reuse packaged renderer
assets and expose the existing bridge API through a separate browser adapter. Permit one remote
shell-input controller and additional read-only viewers. Keep workspace editing, terminal lifecycle,
OS operations, and PTY sizes on the desktop. Authentication, revocation, rate limits, exact
Host/Origin checks, bounded queues, and served-page CSP ship in this phase.

## Options considered

| Option | Complexity | Cost | Scalability | Team familiarity |
| --- | --- | --- | --- | --- |
| Embedded axum / Tokio WebSockets | Moderate | Small dependency addition | Eight local sessions | Uses the existing Rust/Tokio host |
| Separate crate/process | Higher | Additional IPC and packaging | Independent process lifetime | New host protocol required |
| Full LAN/mobile implementation in one PR | High | Certificates, networking and mobile QA | Multiple devices | Additional native and Safari validation |

Embedding avoids a second mutable host and keeps OS operations behind the existing actor. A
separate transport crate can be extracted later without defining another shell-control backend.
Phasing keeps the first PR reviewable while explicitly leaving LAN/mobile acceptance incomplete.

## Trade-off analysis

Browser input goes through the same terminal-manager validation inside the host actor, on a
separate socket-ordered path that never resets or consumes desktop IPC sequence numbers. An
authorization flag is checked again inside the actor to reject input queued before revocation.
Only the desktop acknowledges output. A broadcast channel with bounded capacity disconnects
lagging browser clients; a global 2 MiB output replay buffer exists only while access is enabled.
Browser initialization snapshots actor state and subscribes atomically, without desktop initialize.

The remote command surface is deliberately limited to terminal input. Viewers cannot submit it;
neither role can invoke native dialogs, clipboard, updates, links, lifecycle, filesystem, or server
management. Browser clipboard access stays in the browser. Packaged assets are allowlisted and
workspace images use the existing content-addressed validator.

## Consequences

- Desktop renderer API, format 3 persistence, local capabilities, and desktop CSP remain intact.
- No TLS or certificate management is necessary for loopback HTTP. Non-loopback binding is absent.
- Token/session state is memory-only. Restarting the app turns access off and loses old credentials.
- New browser windows see bounded recent output, without a complete terminal-screen serializer.
- Remote workspace editing and lifecycle control require a future conflict/ownership design.
- #30 and #35 remain independent: this transport follows the current single desktop host lifetime.

## Action items

- [x] Implement loopback HTTP/WebSocket, desktop controls, authentication, viewers, and regression tests.
- [ ] Validate all three CI runners, ten native Windows E2E passes, desktop manual checks, and clean-machine packages.
- [ ] Add explicit interface selection, TLS or configured VPN encryption, and QR pairing in a later phase.
- [ ] Implement mobile interaction and validate Safari on physical iPhone and iPad before claiming #39 complete.
