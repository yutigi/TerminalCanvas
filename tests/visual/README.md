# Renderer layout parity

Run `npm run test:layout` on macOS with Xcode command line tools installed. Use
`npm run test:layout -- --verify-regression` to also prove that the check detects
the original WebKit shift. If Electron is not installed in this checkout, pass
`--electron=/absolute/path/to/Electron.app/Contents/MacOS/Electron`.
The pinned reference commit must be available locally. For an exported source
tree without Git history, pass `--reference-repo=/path/to/the/original/checkout`.

The golden reference is the actual JavaScript UI at the immutable commit in
`reference.json`. The runner extracts its renderer files with Git and renders
them in Electron with the same pinned xterm assets. It then renders the current
UI in Electron and native WKWebView, Tauri's macOS rendering engine. Both hosts
receive the same captured workspace/profiles through an inert test bridge.
They never start a shell or access the user's workspace or clipboard.

Nine scenes cover the empty canvas, launch dialog, and stopped terminal at
1000×680, 1280×720, and 1440×840 content sizes. Control and icon bounds must agree
between current Chromium and WebKit within 0.5 CSS pixels; colors must match.
Current controls must remain within 1.5 CSS pixels of the previous JavaScript UI,
allowing its fractional line boxes to become whole pixel boxes. Missing controls
and viewport mismatches fail the check. `--verify-regression` additionally renders
the unmodified reference in WebKit and requires the strict parity check to fail.

PNGs, full measurements, and `result.json` are written to `.cache/layout-check/`.
Transitions are disabled for captures. The screenshots support visual review;
the automated comparison uses geometry and colors, since different engines draw
font edges differently. This checks the renderer, not Tauri IPC or native window
decorations. Windows/WebView2 and Linux need their own native runtime validation;
macOS results do not establish their visual parity.
