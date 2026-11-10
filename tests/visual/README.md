# Renderer layout parity

Run `npm ci --prefix tests/visual`, then `npm run test:layout` on macOS with Xcode command line tools installed. Use
`npm run test:layout -- --verify-regression` to also prove that the check detects
the original WebKit shift. If Electron is not installed in this checkout, pass
`--electron=/absolute/path/to/Electron.app/Contents/MacOS/Electron`.
The pinned reference commit must be available locally. For an exported source
tree without Git history, pass `--reference-repo=/path/to/the/original/checkout`.

The nested manifest/lockfile pins the test-only Electron runtime outside the app's
dependencies and shipped frontend. CI installs it separately, including after
the Rust-only cutover. An explicitly supplied executable takes precedence.

The golden reference is the actual JavaScript UI at the immutable commit in
`reference.json`. The runner extracts its renderer files with Git and renders
them in Electron with the same pinned xterm assets. It then renders the current
UI in Electron and native WKWebView, Tauri's macOS rendering engine. Both hosts
receive the same captured workspace/profiles through an inert test bridge.
They never start a shell or access the user's workspace or clipboard.

Twelve scenes cover the empty canvas, launch dialog, stopped terminal, and a board
with a connector plus plain, colored, and multiply selected arrows at 1000×680,
1280×720, and 1440×840 content sizes. Control and icon bounds must agree
between current Chromium and WebKit within 0.5 CSS pixels; colors must match.
Current controls must remain within 1.5 CSS pixels of the previous JavaScript UI,
allowing its fractional line boxes to become whole pixel boxes. Missing controls
and viewport mismatches fail the check. `--verify-regression` additionally renders
the unmodified reference in WebKit and requires the strict parity check to fail.
For current Chromium and WebKit, it also hides arrowhead fill deliberately and
requires the rendered arrow checks to fail.

Fixture windows can extend beyond the runner's display, and captures wait for the
exact requested content size. Every report must retain that size; a smaller CI
display must not silently shrink either reference or current windows.
Reports include the native device pixel ratio. The macOS compatibility sheet
preserves both Retina and 1× control boxes, since Chromium's old `normal` line
heights round differently at those display densities. The same geometry
tolerances apply at both densities.

Arrow checks read actual browser styles and pixels decoded from the captured PNG.
The sample lies inside the filled triangle and off the shaft, so removing
`.line-head { fill: currentColor }` fails even when its `d` and `transform` remain
correct. The fixed 2px stroke-width contract is checked with the geometry. Chromium
also emulates `forced-colors: active` and verifies plain, colored, and selected
arrow pixels. Windows WebView2 repeats those checks in `tests/e2e/board.test.cjs`;
this emulation does not change OS High Contrast settings.

PNGs, full measurements, and `result.json` are written to `.cache/layout-check/`.
Transitions are disabled for captures. The screenshots support visual review;
the automated comparison uses geometry, colors, and selected arrow pixels, since
different engines draw font edges differently. This checks the renderer, not Tauri IPC or native window
decorations. Windows/WebView2 and Linux need their own native runtime validation;
macOS results do not establish their visual parity.
