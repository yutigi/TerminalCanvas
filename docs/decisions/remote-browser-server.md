# ADR: Embed an authenticated browser server

**Status:** Accepted for local and private-network browser access
**Date:** 2026-11-18
**Deciders:** Repository owner, with implementation scope confirmed in the task conversation

## Context

Issue #39 requests browser access over LAN/VPN and mobile Safari. The desktop currently has one
host actor, one renderer event channel, per-terminal IPC input sequences, and desktop-owned
workspace recovery. Calling desktop initialization from another client would reset recovery and
input sequencing. Multiple renderers acknowledging output would also defeat PTY backpressure.

## Decision

Embed axum's HTTP/WebSocket server in `src-tauri`, opt-in from the authorized main webview only.
Default to loopback HTTP. Network mode binds one private IPv4 interface using HTTPS and a local
certificate the user trusts on their devices. Reuse packaged renderer assets with a browser bridge.
Allow one controller and additional read-only viewers. Both modes enforce authentication, revocation,
rate limits, exact Host and Origin checks, bounded queues, and served-page CSP.

## Options considered

| Option | Complexity | Cost | Scalability | Team familiarity |
| --- | --- | --- | --- | --- |
| Embedded axum / Tokio WebSockets | Moderate | Small dependency addition | Eight local sessions | Uses the existing Rust/Tokio host |
| Separate crate/process | Higher | Additional IPC and packaging | Independent process lifetime | New host protocol required |
| Full LAN/mobile implementation in one PR | High | Certificates, networking and mobile QA | Multiple devices | Additional native and Safari validation |

Embedding avoids a second mutable host and keeps OS operations behind the existing actor. A
separate transport crate can be extracted later without defining another shell-control backend.
Keep physical-device and mobile acceptance in the validation checklist.

## Trade-off analysis

Browser input goes through the same terminal-manager validation inside the host actor, on a
separate socket-ordered path that never resets or consumes desktop IPC sequence numbers. An
authorization flag is checked again inside the actor to reject input queued before revocation.
Only the desktop acknowledges output. A broadcast channel with bounded capacity disconnects
lagging browser clients; a global 2 MiB output replay buffer exists only while access is enabled.
Browser initialization snapshots actor state and subscribes atomically, without desktop initialize.

The controller can send terminal input, manage terminals, and edit or replace the workspace.
The desktop renderer claims one request at a time through the host actor, which checks the workspace
epoch and the controller's authorization. The renderer applies the operation through its usual
validated host commands and recovery writes, then the browser receives the shared workspace and
terminal changes. This keeps desktop edits and browser lifecycle changes on the same layout.
Viewers can read workspace state and terminal output. Browser clipboard access stays in the browser.
The browser server exposes packaged assets and workspace images through existing allowlists and
content-addressed validation. Browsers use local file pickers and downloads. Host folder dialogs,
app updates, and browser server management stay in the desktop app.

## Consequences

- Desktop renderer API, format 3 persistence, local capabilities, and desktop CSP remain intact.
- Network mode uses an in-memory certificate authority. Client devices need the exported root certificate.
- Token/session state is memory-only. Restarting the app turns access off and loses old credentials.
- New browser windows see bounded recent output, without a complete terminal-screen serializer.
- Browser layout changes compare their starting layout with the current desktop workspace before saving.
- Clients keep their own navigation, and terminal sizes follow the desktop.
- #30 and #35 remain independent: this transport follows the current single desktop host lifetime.

## Action items

- [x] Implement loopback HTTP/WebSocket, desktop controls, authentication, viewers, and regression tests.
- [ ] Validate all three CI runners, ten native Windows E2E passes, desktop manual checks, and clean-machine packages.
- [x] Add explicit private-interface selection and HTTPS.
- [ ] Add QR pairing.
- [ ] Implement mobile interaction and validate Safari on physical iPhone and iPad before claiming #39 complete.
