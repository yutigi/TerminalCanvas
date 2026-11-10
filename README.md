# Terminal Canvas

A desktop canvas for managing multiple AI terminals. Keep a shell, Claude Code, Codex, Gemini CLI, or your own command in separate movable cards, each with its own project folder.

This initial implementation shares Electron with the neighboring WebCanvas project. WebCanvas integration is planned; it is not included yet.

![Terminal Canvas desktop UI showing the empty workspace, terminal profiles, and canvas controls.](docs/images/terminal-canvas.png)

## Run locally

Use Node.js 22.12+ and npm. Windows 10 1809+ or Windows 11 is the primary target. The standard Windows setup uses the node-pty binary included in the dependency when it passes a real terminal check inside Electron.

```powershell
npm install
npm run rebuild
npm start
```

`npm install` needs access to the npm registry and Electron downloads. `npm run rebuild` verifies node-pty inside Electron on Windows and compiles it from source only if the existing binary fails. Other platforms compile from source. Rerun it after changing Electron or native dependencies. AI CLIs must already be installed, available on your `PATH`, and authenticated; Terminal Canvas does not install or sign in to them.

A dependency lockfile is included. Use `npm ci` instead of `npm install` for an exact install from that lockfile.

After installing, a `postinstall` step (`scripts/patch-node-pty.cjs`) applies node-pty 1.2's guard to node-pty 1.1.0's Windows console list helper. Without it, closing a terminal printed an uncaught `AttachConsole failed` stack trace, because the helper tried to attach to a shell that had already exited. The step is idempotent, leaves unrecognized node-pty versions unchanged, and can be removed after upgrading to a node-pty release that includes the guard.

### Source-build troubleshooting

To force compilation, run `npm run rebuild -- --from-source`. Windows source builds require Python and Visual Studio Build Tools with Desktop development with C++, a Windows SDK, and MSVC Spectre-mitigated libraries matching the compiler toolset and target architecture. If you see `MSB8040: Spectre-mitigated libraries are required`, open **Visual Studio Installer → Modify → Individual components**, install those matching libraries, then retry the source build. The default Windows rebuild can use the verified bundled binary without these compiler components.

`npm run build` also invokes native compilation through electron-builder, so packaging currently requires the source-build prerequisites.

For a dependency-free **layout preview**, run `npm run dev` and visit [localhost:4174](http://127.0.0.1:4174). The preview supports card layout and browser-local recovery; it cannot launch shells, choose native folders, or open/save workspace files. It does not simulate AI output.

## Use the workspace

- Choose **New terminal** or a sidebar profile. Set a name, project folder, and optional shell command, then start it.
- Drag a card's header to move it; drag its lower-right corner to resize. Drag empty canvas or middle-drag to pan. Use Ctrl + scroll to zoom.
- Use **Arrange**, **Fit canvas**, and **Focus** to organize your terminals. Filter the sidebar to find a terminal by name, profile, or folder.
- Use the bottom-right **minimap** to locate terminals and see the current view. Click to recenter or drag the view rectangle to pan; with the minimap focused, use arrow keys (Shift for larger steps). Toggle it from the canvas toolbar. It hides when the canvas is empty or in Focus mode.
- Use **Duplicate** in a card header or **Ctrl + Shift + D** to start a fresh plain shell in that terminal's current directory. It gets a separate process and empty output; the source launch command and AI session are not copied. Ctrl + D keeps its normal terminal behavior.
- **Browse** opens at the valid folder displayed in the creation dialog. Invalid or unavailable paths fall back to home, then the app's working directory; canceling preserves the input.
- Use the card's stop/start controls to end or relaunch its shell. Closing a running card asks before stopping it.
- Click a terminal hyperlink to open its HTTP/HTTPS destination directly in your default browser. Unsupported schemes and URLs containing credentials are blocked. Plain-text URL detection is not included.
- Drag to select terminal text at any canvas zoom; dragging a terminal scrollbar thumb while zoomed away from 100% still moves at the wrong speed, so use the mouse wheel there.
- In a terminal, **Ctrl + C copies selected text**; with no text selected, it sends the shell interrupt. Click inside the terminal to clear a text selection before interrupting. **Ctrl + V pastes** clipboard text. Ctrl + Shift + C/V also copy/paste; explicit copy with no selection leaves the clipboard intact. These shortcuts work in both canvas and fullscreen **Focus** views and leave text fields and canvas shortcuts alone.

On macOS, Command + C/V also copy/paste; Ctrl + C still interrupts when no text is selected. Windows desktop behavior is tested with real native key events, clipboard IPC, and PowerShell. macOS aliases have automated handler coverage, but macOS and Linux desktop behavior has not been validated. Clipboard shortcuts require the desktop app; the browser layout preview does not provide clipboard IPC.

Paste accepts plain text up to 64,000 characters and uses xterm to normalize line endings and respect bracketed-paste mode. The shell or running program must enable bracketed paste; without it, pasted newlines can execute commands immediately. Oversized text and OS clipboard failures appear as a notification. Copying an empty selection does not erase existing clipboard text.

![The in-app shortcut guide explaining selection-aware copy, paste, and interrupt.](docs/images/terminal-clipboard-shortcuts.png)

### Board items

The left canvas toolbar adds items around your terminals. Click to place an item at its default size, or drag to draw it; the tool then returns to Select.

- **Text label** and **sticky note** open for typing immediately. Double-click a label, note, or shape to edit its plain text; press Esc or Ctrl + Enter, or click elsewhere, to finish. An empty text label is removed.
- **Rectangle** and **ellipse** shapes can hold centered text.
- **Line** and **arrow** draw free-standing lines. Start or end a line on any terminal or item to attach it as a connector; attached ends follow the item when it moves. Select a line to drag its end handles and reattach them. Deleting an attached item leaves the line in place with a free end.
- **Frame** draws a titled section. Drag it by its title, which you can double-click to rename. Everything fully inside a frame, including terminals, moves with it. Its empty area still pans the canvas.
- **Image** opens a file picker. You can also paste an image or drop image files onto the canvas. PNG, JPEG, GIF, and WebP files up to 15 MB are supported.
- Shift + click adds or removes elements from the selection; Shift + drag on empty canvas selects every element fully inside the rectangle. Drag any selected element to move the whole selection. Click empty canvas to clear the selection.
- **Ctrl + G** groups the selection so it selects and moves as one unit; **Ctrl + Shift + G** ungroups. Groups can include terminals and other groups, up to eight levels deep. Selecting any member selects the outermost group, and ungrouping removes one level at a time.
- The style bar at the top of the canvas appears when the selection includes text labels, notes, shapes, frames, or lines. Pick one of seven colors or the default look, and a small, medium, large, or extra-large text size for items that hold text. Terminals and images have no style options.
- **Ctrl + C**, **Ctrl + X**, **Ctrl + V**, and **Ctrl + D** copy, cut, paste, and duplicate the selected board items, including everything inside a selected frame. Each paste is offset from the last, or lands in the middle of the view if the original is out of sight. Connectors between copied items stay attached; other attached ends become free. Terminals are not copied. Copying also puts the items' text on the system clipboard; if you copy something else afterwards, Ctrl + V pastes that instead.
- **Ctrl + Z** undoes and **Ctrl + Shift + Z** or **Ctrl + Y** redoes board changes: creating, deleting, moving, resizing, and restyling items, editing text, connectors, grouping, and terminal moves, resizes, and Arrange. The canvas toolbar has matching buttons. Undo never creates or closes a terminal, because that would start or stop a process; a connector attached to a terminal you have since closed comes back with a free end. History keeps the last 100 changes and is cleared when you open or start a workspace.
- **Delete** or **Backspace** removes selected board items. Terminals are only removed with their close button, which stops running shells safely.

Line styles and fonts other than the size choices are not configurable.

On Windows, cards open the built-in Windows PowerShell (`powershell.exe`) by default. PowerShell cards start with a `RemoteSigned` execution policy for that shell only, so script shims such as `npm.ps1` run even when the system policy is `Restricted`. Policies set through Group Policy still take precedence, and no system setting is changed. Optional launch commands run inside PowerShell, except the plain shell launchers described below. Use `pwsh` as the launch command for PowerShell 7 if installed, or `cmd.exe` for Command Prompt. Other systems use the login shell selected by `SHELL`, falling back to Bash; those platforms have not been validated.

### Live terminal folders

A running card shows its shell's last reported current folder, including changes made with `cd`, `Set-Location`, or directory-stack commands. The full path is available on hover. Each terminal tracks its own folder. The last valid folder is saved for reopening and fresh shell starts; AI resumes use the captured session folder. An unavailable live directory leaves the last valid saved folder intact.

- **Windows PowerShell 5.1** (default) and **PowerShell 7**: a session-local prompt wrapper emits an encoded file URI after commands finish. Profiles and the existing prompt load normally; no profile file is edited. For PowerShell 7, set the launch command to exactly `pwsh` or `pwsh.exe`. Plain `powershell` / `powershell.exe` launchers also receive integration.
- **Command Prompt**: set the launch command to exactly `cmd` or `cmd.exe`. Its process-local `PROMPT` includes a directory report while preserving the existing visible prompt. These plain Windows shell launchers now start directly, so exiting them ends the terminal session.
- **Linux / macOS**: the managed login shell's process directory is queried about once per second, using `/proc/<pid>/cwd` on Linux and `/usr/sbin/lsof` on macOS. This works with native shells such as Bash and Zsh without modifying their startup files. Permission failures or a missing `lsof` report an unavailable directory. These platform adapters have automated coverage but have not been tested on a Linux or macOS desktop.

Before the first report, after a failed lookup, or in a PowerShell non-filesystem location (such as `HKCU:`), the running card shows **Current directory unavailable**. Stopped/restored cards initially show their last saved folder. Windows updates occur when the prompt returns; a long-running command can leave the last reported folder visible until then. Replacing the PowerShell prompt or cmd `PROMPT` after startup can disable reporting. Nested/remote shells, WSL launched inside Windows, shell launch commands with extra arguments, and applications that maintain their own logical directory are not automatically integrated; Unix polling continues to describe the managed top-level shell. Reports are display metadata, never input or instructions to change a process directory.


| Shortcut | Action |
| --- | --- |
| Ctrl + Shift + N | New terminal |
| Ctrl + Shift + D | Duplicate selected terminal into a fresh shell |
| Ctrl + S / Ctrl + O | Save / open workspace |
| Ctrl + Shift + F | Toggle focus for the selected terminal |
| Ctrl + C in a terminal | Copy selected text, or interrupt with no selection |
| Ctrl + V / Ctrl + Shift + V in a terminal | Paste clipboard text |
| Ctrl + Shift + C in a terminal | Copy selected text; no selection leaves clipboard intact |
| / outside a terminal or input | Search terminals |
| V / H | Select / hand tool |
| T / N / R / O / L / A / F | Text, sticky note, rectangle, ellipse, line, arrow, frame tool |
| Esc | Return to the Select tool, then clear the selection |
| Ctrl + G / Ctrl + Shift + G | Group / ungroup the selection |
| Ctrl + Z / Ctrl + Shift + Z or Ctrl + Y | Undo / redo board changes |
| Ctrl + C / X / V / D | Copy, cut, paste, or duplicate board items |
| Delete / Backspace | Delete selected board items |

Single-key and board shortcuts apply only when focus is outside a terminal or text field, so they never reach a running shell.

### Directory tracking and fallback

Windows PowerShell and PowerShell 7 report their FileSystem location at each prompt, including after `cd`, `Set-Location`, and `Push-Location`. Duplicate uses the same directory reports as the live folder display and requires an idle shell. The session wraps the existing `PSConsoleHostReadLine` function, preserving its reader and key bindings, to clear readiness before each accepted line executes. This also covers pasted commands buffered inside PSReadLine, which a console key-queue check cannot detect. The final idle prompt restores duplication. Missing or subsequently replaced readers require folder review. Custom prompt output, `$?`, strict mode, and native exit status are preserved.

While a command/AI CLI or nested shell is running, before the first prompt, in a non-filesystem provider such as `HKCU:`, or when the console cannot confirm idle input, Duplicate opens the New terminal dialog with an explanation and the first available folder: the source last saved directory, home, then the app's working directory. Review or browse before starting. Deleted/inaccessible directories and stopped cards follow the same flow. Command Prompt updates its live folder label but cannot confirm idle input, so Duplicate uses the review dialog there as well.

On Linux and macOS, Duplicate queries the managed shell's process directory afresh rather than reusing the display's polling cache (`/proc/<pid>/cwd` on Linux, `/usr/sbin/lsof` on macOS). A missing tool or failed lookup opens fallback review. These adapters have automated coverage but have not been validated on those desktops. Directories belonging to independently launched child shells are not tracked; native folder-picker behavior outside Windows remains unvalidated.

## Persistence and process lifecycle

Layouts autosave to Electron's user-data directory, normally `%APPDATA%/terminal-canvas/workspace.terminalcanvas` on Windows. **Save workspace** exports a portable `.terminalcanvas` JSON file. A workspace contains names, geometry, profile IDs, project paths, launch commands, optional AI session metadata (provider, UUID, and session folder), and board items with their text, colors, text sizes, groups, and connectors. It does not save terminal output, credentials, or process IDs. Keep secrets out of launch commands because those commands are saved in plain text. Session IDs identify local conversation history; they do not transfer that history or authentication to another computer.

Images are copied into `%APPDATA%/terminal-canvas/assets/` under a SHA-256 content name; workspace files store only that name, so a regular saved workspace opened on another computer shows *Image unavailable*. Choose **Export portable copy** in the sidebar to write a separate file with every referenced image embedded. Opening that file copies the images back into the local assets folder, re-hashing each one; the file must be smaller than 64 MB. Image bytes are validated by signature, never by file name, and SVG is not accepted.

Images stay in the assets folder after you remove them from the board. Choose **Clean up images** in the sidebar to delete the ones that the current workspace, its undo history, and copied items no longer use; it shows how many and how much space first, and asks before deleting. Workspace files you saved earlier that are not portable copies show deleted images as *Image unavailable*, so export portable copies of layouts you want to keep before cleaning up.

Workspace format version 3 stores nested groups, item colors, and text sizes. Files in format 1 (version 0.1) and format 2 open unchanged and are saved as format 3. Earlier versions of Terminal Canvas cannot open format 3 files.

Restored cards are stopped until explicitly started, both on reopening the app and when importing a workspace. Cards with a captured AI session ID offer **Resume session**, which starts a new shell in the session folder and runs `codex resume <UUID>` or `claude --resume <UUID>`. **Start fresh shell** opens a plain shell without running the saved command, retaining the last captured AI ID for a later retry. For a new AI conversation, launch the tool in that shell. Without an ID, **Start terminal** runs the configured launch command. The header also offers a fresh-shell button after a process exits; stop a running shell before using it.

### What can be recovered

- **Shell folders:** the integrated Windows PowerShell prompt reports the latest filesystem directory after each command. Bash also has a prompt integration, installed after its normal login profiles finish so their environment and prompt setup remain available. Command Prompt uses its process-local PROMPT reports. Linux and macOS also poll the managed shell directory, including shells without prompt integration; OSC 7 reports are supported on Windows. Starting a fresh shell falls back to Home if the saved folder has disappeared. An AI resume with a missing session folder reports the problem and retains its ID.
- **Claude Code:** ordinary `claude` launches, including those typed manually in a terminal, are wrapped with a per-terminal `SessionStart` hook. An argument-free launch also receives an explicit `--session-id`. The hook reports UUID changes on startup, resume, and clear, without reading transcripts. If you supply your own `--settings`, Terminal Canvas leaves that launch's settings alone and cannot install its hook. Disabled hooks, overridden shell functions, nested shells, and absolute executable paths can prevent automatic capture.
- **Codex:** ordinary `codex` launches through the integrated shell are recognized, and explicit UUIDs passed to `codex resume` are captured. While that launch is active, a line beginning with `session id:` or `To continue this session, run codex resume <UUID>` also supplies an ID. Mentions of resume commands in ordinary shell output, in other tools, or after the Codex launch ends are ignored. Some interactive versions only print the hint when exiting: quitting the app or crashing before that output is available cannot recover that new conversation's ID. Terminal Canvas does not replace Codex hooks or guess the latest conversation from a shared history folder. Names and picker-only resumes are not treated as unique IDs.
- **Failed resumes:** missing tools and nonzero tool exits leave a usable shell and the saved metadata available. The tool displays authentication, expired/deleted-session, and other provider errors in the terminal. There is no automatic retry or substitution with a different conversation. Install/authenticate the tool, stop the shell, then retry Resume, or choose Start fresh shell. A syntactically valid UUID cannot prove the provider still has the conversation.
- **Unexpected shutdowns:** host-observed folder and ID changes queue an immediate atomic recovery write, independently of the renderer's 500 ms layout debounce. Hook files are polled every 500 ms and read again on tool exit, terminal stop, save/export, and app close. A normal close flushes the final snapshot before exiting; a renderer crash preserves the last host-known layout. A forced process kill or power loss can still lose changes not yet observed or written. Orphaned integration files may remain in the app's data folder after a crash; they contain no terminal output or credentials.

Shell variables, activated environments, terminal scrollback, running commands, and process memory are not recovered. Closing the app stops its managed terminals. Gemini and arbitrary custom tools retain their shell folder and configured command but have no provider-specific resume integration. A maximum of 24 cards, 1,000 board items, and 5,000 scrollback lines per terminal bounds the workspace.

The supported resume commands and Claude hook input are described in the [Codex CLI reference](https://developers.openai.com/codex/cli/reference), [Claude CLI reference](https://code.claude.com/docs/en/cli-reference), and [Claude hooks reference](https://code.claude.com/docs/en/hooks). Only per-launch settings and files under the app's user-data directory are created; global CLI configuration is not edited.

## Development and validation

| Command | Purpose |
| --- | --- |
| `npm start` | Launch the Electron desktop app |
| `npm run dev` | Serve the layout preview on loopback port 4174 |
| `npm run rebuild` | Verify the Windows native binary in Electron, or rebuild when needed |
| `npm run icons` | Regenerate native PNG/ICO icons from `src/assets/logo.svg` using the Rust resvg task |
| `npm run check` | Check JavaScript syntax and the package manifest |
| `npm test` | Run icon, workspace, board geometry, image asset, minimap, session metadata/recovery, shell integration, directory-tracking, external-link, terminal pointer mapping, terminal-manager, rebuild, node-pty patch, renderer, undo, terminal clipboard IPC, board clipboard, and smoke-helper tests (no npm test framework; Windows prompt checks invoke built-in PowerShell and optionally PowerShell 7) |
| `npm run test:smoke` | Check fresh-shell duplication, queued-command safety, folder-picker defaults/cancellation, the desktop renderer, native terminal copy/paste and interruption, board clipboard commands, native hyperlink clicks without confirmation (with the OS launch intercepted), minimap navigation, live shell directory changes, first-click terminal typing, terminal text selection, copying, and mouse reports at several zoom levels and in Focus mode, board items (image loading, image cleanup, connector hit testing, note typing, grouping, undo/redo, copy/paste), real PTY output, resize, and cleanup; save `.cache/smoke-creation.png`, `.cache/smoke-links.png`, `.cache/smoke.png`, `.cache/smoke-first-click.png`, `.cache/smoke-board.png`, `.cache/smoke-clipboard.png`, and `.cache/cwd smoke/*.png` |
| `npm run test:restoration` | Windows: run two Electron launches with an isolated recovery profile and controlled CLI substitute; verify manual AI capture, actual shell folder changes, hook metadata, close-time flush, stopped cards on reopening, exact-ID resume, and a fresh shell; save `.cache/restoration.png` |
| `npm run build` | Package an unsigned Windows portable executable in `release/` |

Terminal-manager tests use a controlled PTY substitute; the smoke test requires installed desktop dependencies and checks the real native integration. It sends native mouse and keyboard input and waits until the page has dispatched each sequence before checking the result, because native input and page scripts reach the renderer on separate channels. Before each sequence it takes back window focus if another window took it, because native keys reach the focused element only while the window has focus. The smoke test uses the system clipboard and puts back everything that was on it afterwards. Image cleanup runs against the smoke test's own profile in `.cache/smoke-profile`, never your assets folder. Screenshot capture retries transient `UnknownVizError` failures up to five times, requesting a repaint and waiting 100 ms between attempts. Persistent failures, unrelated errors, and empty captures still fail the test. Current integrated Windows validation passed syntax checks, all 172 automated tests, the complete desktop smoke suite, and the two-launch restoration test after merging the clipboard and canvas editing PRs. Restoration uses an isolated profile and controlled local CLI substitute; real provider authentication/resume and Linux/macOS desktops remain unverified. The combined desktop smoke test includes native GitHub hyperlink clicks, unsafe-scheme rejection, and live shell directory changes. Its terminal selection check, at 45%, 65%, 80%, 100%, and 150% zoom and in Focus mode, also passed with `npm run test:smoke -- --force-device-scale-factor=1.25` and `=1.5`; without the pointer correction, every non-100% zoom case fails. A separate native-click check previously launched the real default browser without confirmation. The board and hyperlink screenshots were visually inspected. Before the smoke test waited for native input, its first-click focus check failed intermittently (5 of 14 runs) even though the terminal received focus a moment later. Before it took back window focus, the board check `typing reaches the note editor without triggering tool shortcuts` failed whenever the smoke window lost focus mid-run (1 of 6 runs here, 4 of 13 in earlier runs on `main`); blurring the window before that check reproduced the failure every time. The native icon comparison against the SVG passed previously. The node-pty `AttachConsole failed` shutdown message no longer appears in smoke runs with the install patch (0 occurrences in 8 runs, compared with 8–9 per run without it). The default rebuild command passed previously; forced source compilation is blocked on this machine by missing MSVC Spectre-mitigated libraries. The working-directory hotfix also passed real Windows PowerShell 5.1, PowerShell 7, and cmd directory checks (spaces, Unicode and reserved characters, independent terminals, failed directory changes, unavailable provider locations, and normal output) plus the full desktop smoke test. Follow-up regression checks cover strict-mode prompts with an absent or existing native exit code in both PowerShell versions, and local-machine/localhost UNC URI decoding. Packaging was attempted and failed with `MSB8040: Spectre-mitigated libraries are required for this project`; the required MSVC libraries remain missing. Linux and macOS desktop validation remains unavailable.

The clipboard bridge awaits Electron 45 asynchronous reads/writes before returning IPC results and enforcing text limits. Pending paste is tied to the originating process generation, so a terminal restart discards stale clipboard responses. Clipboard smoke fixtures are isolated from live shell repaints; real process interruption is checked separately in each view. Native text-field checks use Command on macOS and Control elsewhere. The smoke harness disables background animation/timer throttling so native shell helpers cannot suspend its frame-based assertions.

The Duplicate readiness regression is fixed: all 189 integrated automated tests and syntax/package checks pass, along with the full Windows desktop smoke suite and two-launch restoration test. Native queued-command checks in Windows PowerShell 5.1 and PowerShell 7 require folder review while the later pasted command runs and verify direct duplication recovers in the final folder. The creation workflow also verifies the review dialog opens without starting a process. Regression tests cover accepted-line invalidation, missing/replaced/throwing readers, reader output and status, custom prompts, strict mode, and native exit status. Packaging and other-platform limitations above still apply.

### Rust host (in progress)

The Electron host is being replaced by a Rust host on Tauri 2, following [docs/rust-migration-plan.md](docs/rust-migration-plan.md). The Electron app stays the one you run and ship until the plan's last phase. So far the repository has the Cargo workspace and CI (Phase 0); `crates/tc-core`, the host logic that needs no UI and no child processes (Phase 1); and the process layer (Phase 2): `crates/tc-pty` starts shells in PTYs and tracks their folders and AI sessions, and `crates/tc-hook` is the small sidecar the shell integration runs in place of `session-hook.cjs`. The Tauri host, Windows E2E suite, and packaging preparation are now implemented and under native validation.

Install Rust with rustup; `rust-toolchain.toml` pins Rust 1.95 with rustfmt and clippy. `tc-core` parses URLs with Ada, the parser inside Node, so it also compiles C++20: use Visual Studio Build Tools on Windows (no Spectre libraries needed), Xcode Command Line Tools on macOS, or GCC/Clang on Linux.

| Command | Purpose |
| --- | --- |
| `cargo test --workspace` | Run the Rust tests, including every golden fixture and the item-style parity check (needs `node` on PATH) |
| `cargo xtask check` | Run rustfmt, clippy with warnings as errors, `npm run check`, both test suites, and the golden fixture check |
| `cargo xtask syntax` | Check JavaScript syntax and the package manifest without executing scripts |
| `node scripts/capture-golden.cjs` | Record what the JavaScript host modules do into `tests/golden/`; with `--check`, fail if the files are out of date |
| `npm run test:layout -- --verify-regression` | macOS: compare nine rendered scenes with the pre-migration Electron UI and native WebKit; save PNGs and geometry under `.cache/layout-check/` |
| `cargo build -p tc-hook`, then `cargo run -p tc-pty --example drive -- [--shell bash\|zsh\|pwsh\|cmd] [--ai]` | Start a real shell without the UI, change its folder, and print what the host sees; with `--ai`, also check that stand-ins for Claude Code and Codex have their session IDs captured. Prints `PASS` or `FAIL` |

Windows process cleanup uses a documented local patch to pinned `portable-pty` 0.9.0 (`vendor/portable-pty/PATCH.md`). The host creates a kill-on-close Job Object before spawn and includes it in process creation, rather than optionally attaching a running shell afterwards. Invalid job setup prevents launch. The Unix implementation remains unchanged; the new Windows runtime tests remain pending.

The Tauri host is now implemented in `src-tauri/`, with `src/bridge.js` preserving the renderer API. It is still under validation; `npm start` continues to run Electron. To try the Rust app, build its hook first with `cargo build -p tc-hook`, then run `cargo run -p terminal-canvas`. No Tauri CLI or frontend dev server is needed. The app uses the same `terminal-canvas` data folder as Electron, so a normal launch opens your existing workspace.

Requirements for the Rust desktop build:

- Windows: MSVC Build Tools, including the Windows SDK, and the WebView2 Runtime; the Spectre libraries are not needed.
- macOS: Xcode Command Line Tools. Tauri keeps its standard macOS Edit menu for native Command-key editing shortcuts.
- Ubuntu/Debian: a C++20 compiler plus `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`, and `patchelf`.

For an isolated test launch, run `cargo run -p terminal-canvas --features e2e -- --smoke-test`. Its workspace and webview data live under `.cache/tauri-smoke-profile`; test builds default there even without flags, so launching a test bundle cannot open normal user data. The test-only commands query host state, focus/request closing the window, and intercept link opens; test builds keep the production close-confirmation flow; compiling this feature in a release profile is rejected. On Windows, build with `cargo build -p tc-hook` and `cargo build -p terminal-canvas --features e2e`, then run `node tests/e2e/preflight.cjs` and `npm run test:e2e`. Playwright connects to WebView2 over CDP; the harness sets its debugging port only in the child test process, and the Windows test build passes those arguments through the native API for elevated WebView2 hosts. The two-launch restoration test uses `.cache/tauri-restoration-profile` and controlled local Claude/Codex substitutes. Its PowerShell shells skip user profiles and disable file history/predictions so the fixtures stay isolated; normal builds keep normal login profiles. Screenshots are saved as `.cache/tauri-*.png`.

Current local validation: the Rust workspace tests, host tests with the `e2e` feature, JavaScript tests, golden checks, and clippy pass on macOS. Windows source type-checking uses temporary C++/resource stubs and proves only the Rust types. The native Windows E2E tests have not run here. A native macOS check verified real shell input/output, directory tracking, duplication/Stop, native paste/undo, note styles/zoom, stopped restoration, native image import, and rendered stored images. That check fixed the asset-origin response and last-window exit behavior; the rebuilt host exits with status 0 after closing its native window. The production close-confirmation flow was also checked with a running shell: Cancel preserved it, and Confirm saved the renamed workspace, exited with status 0, and ended the shell. Native Save, repeated Save, portable Export, and Open into an empty profile now pass on macOS, with the image rendered and saved terminals stopped. A native controlled-Bash check also passed capture, exact-ID resume, and fresh-shell recovery across two launches; all six observed shells ended and both runs exited 0. The remaining manual board/clipboard checks remain open. The ported E2E suite includes native selection/clipboard/interruption, hyperlinks, creation and folder dialogs, directory displays in Windows PowerShell 5.1/7 and cmd, minimap navigation, connector hit testing, file drops, image cleanup/export, and browser accelerators; these Windows checks still need execution before cutover.

Windows packaging preparation is available with `cargo install tauri-cli --version 2.12.4 --locked`, then `cargo xtask package-windows` (or `npm run package:rust`). The task builds the release hook, stages it as a Tauri sidecar, runs `cargo tauri build` with `src-tauri/bundle.windows.json`, and writes an NSIS installer and a portable zip to `release/`. Both contain `Terminal Canvas.exe` and `tc-hook.exe` in the same installed/extracted folder. The installer can download the WebView2 Runtime if needed; the portable zip requires it already installed. Windows E2E checks also require PowerShell 7. `.github/workflows/release.yml` builds reviewable artifacts after source validation and ten native E2E passes, reusing the exact validated commit when called by CI; it does not publish a release. Packaging and clean-machine execution remain unverified.

Native icons now use the pinned Rust resvg renderer: `cargo xtask icons` generates them, and `cargo xtask icons --check` verifies them without Electron or a display. The regenerated PNG and nine-size ICO were visually compared against the previous logo. Renderer unit tests now clone `tests/golden/renderer.json`; Rust checks those captured defaults against its own factories.

The golden fixtures record the JavaScript behavior the Rust host must keep: workspace validation and its error messages, the terminal directory and session decoders, image assets, shell integration text, and Node's lenient base64 and UTF-8 decoding. The Rust tests replay every case, and split each terminal stream at every byte to check that output arriving in pieces gives the same result. Platform, home folder, and hostname are fixed in the script, so every machine writes the same files. Regenerate them only after changing JavaScript behavior on purpose, and review the diff.

Rendered layout has a separate [visual parity check](tests/visual/README.md). It extracts the actual JavaScript UI at commit `f489d3b`, renders it in Electron, and compares the current UI in Electron and macOS WKWebView at three content sizes. Twelve scenes pass: current controls stay within 1.5 CSS pixels of the historical layout, and current Chromium/WebKit control and icon bounds agree within 0.5 pixels with matching colors. The negative control detects the original WebKit shifts. A macOS-only compatibility stylesheet makes control line boxes, icon wrappers, and input heights explicit so browser rounding cannot accumulate into shifted rows and dialog buttons; Windows/Linux retain their existing typography. The Tauri window also subtracts measured native decorations so its initial/minimum outer dimensions match Electron's 1500×960/1000×680. The rebuilt native macOS app was visually checked and closed with status 0. Windows/Linux visual results remain unverified.

CI (`.github/workflows/ci.yml`) runs on Windows, macOS, and Linux with Node 22: the JavaScript checks and tests, the golden check, rustfmt, clippy, and the Rust tests. Install npm dependencies with Node 22; npm 11 (Node 24 and later) rejects `package-lock.json` because of missing optional Windows packages. On macOS and Linux, three terminal-manager tests that feed real folders through Windows file URL decoding are skipped.

Source lives in `src/`, scripts in `scripts/`, tests in `tests/`, and design notes in [docs/architecture.md](docs/architecture.md). `AGENTS.md` records the current layout, commands, and migration constraints.

The sidebar, browser favicon, desktop window, and Windows executable use the same logo. After editing `src/assets/logo.svg`, run `npm run icons` and include the updated `icon.png` and `icon.ico` assets. Run `npm run icons -- --check` to verify they match the SVG. Restart the desktop app to see a new window icon; rebuild the portable executable to update its file icon.

Native file workflow artifacts can be checked with the [manual round-trip verifier](tests/manual/README.md). It validates complete layouts and image bytes against the legacy modules; native UI and process observations remain separate. An exact pre-migration Electron process also rewrote the Rust autosave unchanged, and Rust reopened that output with its image rendered. Electron visual inspection remains pending because Computer Use did not approve that app.

The [manual Bash restoration fixture](tests/manual/README.md#bash-session-restoration) uses only local Claude/Codex stand-ins, checks executable resolution before each shell starts, and records exact resume arguments and Unicode directories. File/PID verification is separate from native UI observations. Tauri regenerates command permission descriptors from `src-tauri/build.rs`; `src-tauri/permissions/autogenerated/` is ignored.

A [macOS clipboard guard](tests/manual/README.md#preserve-the-macos-clipboard-during-native-checks) preserves native formats in memory during manual tests. Its private-pasteboard self-test is configured in macOS CI; general clipboard restoration was also checked locally. Native board/xterm clipboard validation remains pending.

PR [#16](https://github.com/yutigi/TerminalCanvas/pull/16) now provides native CI: macOS and Ubuntu passed, while a Windows Unicode hook failure remains under investigation. The rendered regression suite includes connector/arrow pixels, missing-fill negative controls in both engines, and Chromium forced-colors coverage; native WebView2 repeats that coverage once the Windows suite reaches E2E. Install its separately locked test runtime with `npm ci --prefix tests/visual`; it is excluded from application dependencies and bundles.
