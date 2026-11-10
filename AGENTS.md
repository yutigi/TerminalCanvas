# Repository Guidelines

This cutover candidate uses Tauri 2 and Rust. Apply it to the transitional workspace only after the
migration plan's validation gates pass; keep unverified Windows and manual results explicit.

## Layout

- `src/`: shared HTML/CSS/JavaScript renderer and `bridge.js`; no runtime CommonJS host files.
- `crates/tc-core/`: pure validation, recovery, session/OSC parsing, assets, and directories.
- `crates/tc-pty/`: PTYs, shell integration, process cleanup, backpressure, and cwd polling.
- `crates/tc-hook/`: standalone native hook shipped next to the desktop executable.
- `src-tauri/`: commands, platform services, protocol, window/lifecycle, and one host actor.
- `xtask/`: syntax/check/icon/Windows packaging tasks.
- `tests/`: UI unit tests, golden fixtures, and Windows E2E tests. Frozen Node compatibility oracles
  in `tests/reference/node-host/` are dev-only and must never be imported by the app.
- `vendor/portable-pty/`: pinned, licensed upstream source with a documented three-file Windows patch.

## Commands

Rust 1.95 is pinned; use Node 22.12+ for dev-only packages, UI tests, and Windows Playwright.
Install with `npm ci`, build `cargo build -p tc-hook`, then `cargo run -p terminal-canvas` or
`npm start`. `cargo xtask check` runs required local checks; `npm test` runs UI tests.
`cargo xtask icons [--check]` regenerates/verifies native icons. Windows E2E requires the hook,
`cargo build -p terminal-canvas --features e2e`, PowerShell 7, then `npm run test:e2e`.
`cargo xtask package-windows` needs MSVC/Windows SDK and the pinned Tauri CLI in the README.

## Constraints

Keep workspace format 3 compatible with Electron-era files and migrations from formats 1/2.
Preserve validation order/messages, UTF-16 limits, serialized defaults, and the renderer API.
Use four spaces in JavaScript and standard Rust formatting/lints. Add meaningful behavior and
regression tests. Regenerate golden fixtures intentionally and review their diff.

The Rust actor owns mutable host state; OS operations stay behind host validation. Keep capabilities
limited to the local main webview and app commands; retain CSP/navigation/permission restrictions.
Test profiles, controlled CLI substitutes, and generated output must remain separate from user data.
The `e2e` feature defaults to an isolated profile and is forbidden in release builds.

Ignore `node_modules/`, `target/`, `.cache/`, `release/`, `src/vendor/`, and generated sidecars/schemas/command permission descriptors.
Never commit credentials or local configuration. Use concise imperative commit subjects; PRs should
state purpose, validation, limitations, and include visible-behavior evidence where applicable.
All three CI runners, ten native Windows E2E passes, manual desktop checks, and clean-machine
installer/portable checks remain required; local or source-only checks cannot substitute for them.

`npm run test:layout -- --verify-regression` compares the immutable JavaScript UI with current Chromium and native WebKit on macOS. It needs Xcode command line tools and an external Electron test executable (`--electron=...`); use `--reference-repo=...` for an exported tree without Git history. See `tests/visual/README.md`. Generated PNGs and geometry belong under `.cache/`.
