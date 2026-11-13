# Terminal Canvas

A desktop canvas for managing multiple AI terminals, hosted by Tauri 2 and Rust with xterm.js.
Keep independent shells, Claude Code, Codex, Gemini CLI, and custom commands in movable cards.
WebCanvas integration remains planned.

![Terminal Canvas desktop UI](docs/images/terminal-canvas.png)

## Run locally

Use Rust 1.95 (pinned by `rust-toolchain.toml`) and Node.js 22.12+ for development tools.
Nothing in the shipped application requires Node, Electron, or node-pty.

Platform requirements:

- Windows 10 1809+ or Windows 11: MSVC Build Tools with a Windows SDK and C++20 support, plus the
  WebView2 Runtime. MSVC Spectre-mitigated libraries are not needed.
- macOS: Xcode Command Line Tools.
- Ubuntu/Debian: a C++20 compiler and `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`,
  `librsvg2-dev`, and `patchelf`.

```sh
npm ci
cargo build -p tc-hook
cargo run -p terminal-canvas
```

`npm start` also launches the Rust application. Build the hook before the first launch so shell
integration can capture sessions. `build.rs` copies the pinned xterm files from `node_modules`
into ignored `src/vendor/`; if dependencies are missing, it asks you to run `npm ci`.
No Tauri CLI or browser preview server is needed for the development loop. AI tools must already
be installed on PATH and authenticated; Terminal Canvas does not install or sign in to them.

The browser-only layout preview has been retired. A normal launch uses the same `terminal-canvas`
configuration folder as the Electron build, preserving its autosave and content-addressed images.
For an isolated test workspace, build/run with `--features e2e`; it always uses a test profile,
even without command-line flags. Release builds reject the `e2e` feature.

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

On macOS, Command + C/V also copy/paste; Ctrl + C still interrupts when no text is selected. Windows behavior is tested with real native key events, clipboard IPC, and PowerShell. On macOS, these shortcuts were checked by hand in the native app. Linux desktop behavior has not been validated.

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

On Windows, cards open the built-in Windows PowerShell (`powershell.exe`) by default. PowerShell cards start with a `RemoteSigned` execution policy for that shell only, so script shims such as `npm.ps1` run even when the system policy is `Restricted`. Policies set through Group Policy still take precedence, and no system setting is changed. Optional launch commands run inside PowerShell, except the plain shell launchers described below. Use `pwsh` as the launch command for PowerShell 7 if installed, or `cmd.exe` for Command Prompt. Other systems use the login shell selected by `SHELL`, falling back to Bash. macOS has been checked natively; Linux desktop behavior has not been validated.

### Terminals opened by agents

Any AI agent, harness, or script can open a terminal on the canvas, so an agent can hand its work
over to a fresh session or start a helper without you opening the New terminal dialog. Inside a
Terminal Canvas terminal, the new card opens beside that terminal, joined to it by an arrow, and
starts immediately. Programs outside the canvas can ask the running app too; their card opens beside
the card they name with `--parent`, or in view on its own. The caller gets the new card's ID, or why
nothing opened, and with `--log` can read the new terminal's output as it runs.

```bash
# Inside a terminal: Bash, zsh, or Git Bash (Claude Code's Bash tool on Windows)
"$TC_HOOK" new-terminal --profile codex --title "Review" --command 'codex "Review this branch"'
```

```powershell
# Inside a terminal: PowerShell
& $env:TC_HOOK new-terminal --title "API tests" --cwd ..\api --command "npm test" --log --json
```

Every terminal, including Command Prompt, has `TC_HOOK`, `TC_LAUNCH_DIR`, and `TC_CARD_ID` set. See
[Opening terminals from agents and scripts](docs/agent-launch.md) for options, results, output logs,
an instruction snippet for `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`, sandbox notes, and the security
model. A new terminal does not inherit the requesting agent's sandbox.

### Live terminal folders

A running card shows its shell's last reported current folder, including changes made with `cd`, `Set-Location`, or directory-stack commands. The full path is available on hover. Each terminal tracks its own folder. The last valid folder is saved for reopening and fresh shell starts; AI resumes use the captured session folder. An unavailable live directory leaves the last valid saved folder intact.

- **Windows PowerShell 5.1** (default) and **PowerShell 7**: a session-local prompt wrapper emits an encoded file URI after commands finish. Profiles and the existing prompt load normally; no profile file is edited. For PowerShell 7, set the launch command to exactly `pwsh` or `pwsh.exe`. Plain `powershell` / `powershell.exe` launchers also receive integration.
- **Command Prompt**: set the launch command to exactly `cmd` or `cmd.exe`. Its process-local `PROMPT` includes a directory report while preserving the existing visible prompt. These plain Windows shell launchers now start directly, so exiting them ends the terminal session.
- **Linux / macOS**: the managed login shell's process directory is queried about once per second, using `/proc/<pid>/cwd` on Linux and `/usr/sbin/lsof` on macOS. This works with native shells such as Bash and Zsh without modifying their startup files. Permission failures or a missing `lsof` report an unavailable directory. Polling has been checked natively on macOS with zsh and Bash; on Linux it has run only in the CI Bash drive, not on a desktop.

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

On Linux and macOS, Duplicate queries the managed shell's process directory afresh rather than reusing the display's polling cache (`/proc/<pid>/cwd` on Linux, `/usr/sbin/lsof` on macOS). A missing tool or failed lookup opens fallback review. Native macOS duplication/polling and the Linux controlled Bash drive passed; Linux desktop behavior remains unverified. Directories belonging to independently launched child shells are not tracked; native folder-picker behavior outside Windows remains unvalidated.

## Persistence and process lifecycle

Layouts autosave to `workspace.terminalcanvas` in the app's data folder: `%APPDATA%/terminal-canvas/` on Windows, `~/Library/Application Support/terminal-canvas/` on macOS, and `~/.config/terminal-canvas/` on Linux. It is the same folder the Electron build used. **Save workspace** exports a portable `.terminalcanvas` JSON file. A workspace contains names, geometry, profile IDs, project paths, launch commands, optional AI session metadata (provider, UUID, and session folder), and board items with their text, colors, text sizes, groups, and connectors. It does not save terminal output, credentials, or process IDs. Keep secrets out of launch commands because those commands are saved in plain text. Session IDs identify local conversation history; they do not transfer that history or authentication to another computer.

Images are copied into `%APPDATA%/terminal-canvas/assets/` under a SHA-256 content name; workspace files store only that name, so a regular saved workspace opened on another computer shows *Image unavailable*. Choose **Export portable copy** in the sidebar to write a separate file with every referenced image embedded. Opening that file copies the images back into the local assets folder, re-hashing each one; the file must be smaller than 64 MB. Image bytes are validated by signature, never by file name, and SVG is not accepted.

Images stay in the assets folder after you remove them from the board. Choose **Clean up images** in the sidebar to delete the ones that the current workspace, its undo history, and copied items no longer use; it shows how many and how much space first, and asks before deleting. Workspace files you saved earlier that are not portable copies show deleted images as *Image unavailable*, so export portable copies of layouts you want to keep before cleaning up.

Workspace format version 3 stores nested groups, item colors, and text sizes. Files in format 1 (version 0.1) and format 2 open unchanged and are saved as format 3. Earlier versions of Terminal Canvas cannot open format 3 files.

Restored cards are stopped until explicitly started, both on reopening the app and when importing a workspace. Cards with a captured AI session ID offer **Resume session**, which starts a new shell in the session folder and runs `codex resume <UUID>` or `claude --resume <UUID>`. **Start fresh shell** opens a plain shell without running the saved command, retaining the last captured AI ID for a later retry. For a new AI conversation, launch the tool in that shell. Without an ID, **Start terminal** runs the configured launch command. The header also offers a fresh-shell button after a process exits; stop a running shell before using it.

### What can be recovered

- **Shell folders:** the integrated Windows PowerShell prompt reports the latest filesystem directory after each command. Bash also has a prompt integration, installed after its normal login profiles finish so their environment and prompt setup remain available. Command Prompt uses its process-local PROMPT reports. Linux and macOS also poll the managed shell directory, including shells without prompt integration; OSC 7 reports are supported on Windows. Starting a fresh shell falls back to Home if the saved folder has disappeared. An AI resume with a missing session folder reports the problem and retains its ID.
- **Claude Code:** ordinary `claude` launches, including those typed manually in a terminal, are wrapped with a per-terminal `SessionStart` hook. An argument-free launch also receives an explicit `--session-id`. The hook reports UUID changes on startup, resume, and clear, without reading transcripts. If you supply your own `--settings`, Terminal Canvas leaves that launch's settings alone and cannot install its hook. Disabled hooks, overridden shell functions, nested shells, and absolute executable paths can prevent automatic capture.
- **Codex:** ordinary `codex` launches through the integrated shell receive a per-launch `SessionStart` hook. On Codex versions with lifecycle hooks enabled, it reports the exact ID on startup, resume, and clear, before an exit hint is printed. If Codex asks you to review the hook, open `/hooks`, trust the Terminal Canvas command, then restart Codex so its startup hook runs. Terminal Canvas preserves Codex's hook trust checks. Other configuration layers' hooks remain in place, and no global CLI configuration is edited. Explicit CLI overrides of `hooks.SessionStart`, disabled hooks, older Codex versions without lifecycle hooks, nested shells, and absolute executable paths can prevent automatic capture. Explicit UUIDs passed to `codex resume` and active-launch output beginning with `session id:` or `To continue this session, run codex resume <UUID>` remain fallbacks. Without a hook or explicit ID, closing the app before an exit hint is printed cannot recover that new conversation. Ordinary shell output is ignored, and Terminal Canvas never guesses the latest conversation from a shared history folder.
- **Failed resumes:** missing tools and nonzero tool exits leave a usable shell and the saved metadata available. The tool displays authentication, expired/deleted-session, and other provider errors in the terminal. There is no automatic retry or substitution with a different conversation. Install/authenticate the tool, stop the shell, then retry Resume, or choose Start fresh shell. A syntactically valid UUID cannot prove the provider still has the conversation.
- **Unexpected shutdowns:** host-observed folder and ID changes queue an immediate atomic recovery write, independently of the renderer's 500 ms layout debounce. Hook files are polled every 500 ms and read again on tool exit, terminal stop, save/export, and app close. A normal close flushes the final snapshot before exiting; a renderer crash preserves the last host-known layout. A forced process kill or power loss can still lose changes not yet observed or written. Orphaned integration files may remain in the app's data folder after a crash; they contain no terminal output or credentials.

Shell variables, activated environments, terminal scrollback, running commands, and process memory are not recovered. Closing the app stops its managed terminals. Gemini and arbitrary custom tools retain their shell folder and configured command but have no provider-specific resume integration. A maximum of 24 cards, 1,000 board items, and 5,000 scrollback lines per terminal bounds the workspace.

The supported resume commands and Claude hook input are described in the [Codex CLI reference](https://developers.openai.com/codex/cli/reference), [Claude CLI reference](https://code.claude.com/docs/en/cli-reference), and [Claude hooks reference](https://code.claude.com/docs/en/hooks). Only per-launch settings and files under the app's user-data directory are created; global CLI configuration is not edited.

## Development and validation

| Command | Purpose |
| --- | --- |
| `npm ci` | Install the three pinned development dependencies; no native Node install scripts run |
| `cargo run -p terminal-canvas` / `npm start` | Run the Rust desktop host; build `tc-hook` first |
| `cargo xtask check` | rustfmt, clippy, Rust and JavaScript tests, syntax, native icons, and golden parity |
| `cargo test --workspace` | Host/process tests and every golden fixture; the style parity test needs Node on PATH |
| `npm test` | Renderer, geometry, pointer, minimap, bridge, and E2E-helper unit tests |
| `cargo xtask syntax` / `npm run check` | Parse JavaScript and the package manifest without executing scripts |
| `node scripts/capture-golden.cjs --check` | Reproduce frozen Electron-era behavior fixtures from the test-only oracle |
| `cargo xtask icons [--check]` | Generate/verify native icons with pinned resvg, without Electron or a display |
| `npm run test:e2e` | Windows WebView2 desktop/restoration suite after building the E2E app and hook |
| `cargo xtask package-windows` / `npm run build` | Windows NSIS installer and portable zip preparation |
| `npm run test:layout` | macOS rendered-layout comparison with the pre-migration UI; run `npm ci --prefix tests/visual` first (see [tests/visual](tests/visual/README.md)) |

For Windows E2E, install PowerShell 7 as well as the built-in Windows shells, build with
`cargo build -p tc-hook` and `cargo build -p terminal-canvas --features e2e`, then run
`node tests/e2e/preflight.cjs` and `npm run test:e2e`. Playwright connects to WebView2 over a debugging port set only in the child test
process; the test build supplies it through the native API on elevated Windows. Test workspace/webview files stay under `.cache/tauri-smoke-profile` or
`.cache/tauri-restoration-profile`. Controlled local CLI substitutes do not contact providers.
Clipboard tests preserve native formats, and test-only PowerShell shells skip user profiles and disable file history/predictions to keep the fixtures isolated. Native screenshots are saved as `.cache/tauri-*.png`.

`tests/reference/node-host/` contains frozen, standalone compatibility oracles, not an application
host. They use Node built-ins only, are invoked only by the golden capture, and are excluded from
Tauri's frontend and distribution. Rust tests replay all captured fixtures; UI tests read JSON
factory fixtures. Golden updates must be intentional and reviewed.

Windows cleanup uses the documented local `portable-pty` patch in `vendor/portable-pty/PATCH.md`.
A mandatory kill-on-close Job Object is attached in process creation before startup children can
escape. Unix Stop signals process groups. The PTY backend has a reader, writer, and exit waiter;
output pauses at 256,000 unacknowledged UTF-16 units and resumes below 32,000. Input is applied in
per-terminal sequence order, and the host actor owns all mutable terminal/recovery state.

## Windows distribution

Rust builds have not been published as a GitHub release yet. CI builds an NSIS installer and a
portable ZIP for each validated change and keeps them as workflow artifacts.

- **Installer:** installs the WebView2 Runtime if it is missing.
- **Portable ZIP:** keep `Terminal Canvas.exe` and `tc-hook.exe` in the same folder. It needs the
  WebView2 Runtime, which Windows 11 already includes.

Neither package is code-signed, so Windows SmartScreen may warn on first launch.

To build the packages yourself, install the pinned CLI with
`cargo install tauri-cli --version 2.12.4 --locked`, then run `cargo xtask package-windows` on
Windows. It builds the release hook and runs `cargo tauri build` with `src-tauri/bundle.windows.json`,
writing both packages to `release/`. The manual release-artifact workflow validates the source and
ten consecutive Windows E2E runs before uploading; it does not publish a release.

## Upgrading from the Electron build

Version 0.2.0 replaces the Electron host (0.1.0) with Rust and Tauri. The interface and features
are unchanged.

- **Your data carries over.** Both versions use the same data folder, so the autosave, images, and
  saved AI session IDs are picked up with no migration step. Workspace files open in either version.
- **Run one version at a time.** They share recovery data, so running both at once can overwrite
  each other's autosave.
- **Smaller download.** The installer is about 3 MB and the portable ZIP about 4.5 MB, compared with
  114 MB for the Electron portable app. The Rust app uses the system WebView2 instead of bundling
  Chromium; that runtime is not counted in these sizes.
- **Rolling back.** The last Electron app is attached to the
  [`electron-final` release](https://github.com/yutigi/TerminalCanvas/releases/tag/electron-final).
  Its tag marks the last source where Electron was the default.

## Validation status

The Rust-only code passed [CI run 42901548863](https://github.com/yutigi/TerminalCanvas/actions/runs/42901548863)
as candidate `27e8774`:

- Windows, macOS, and Ubuntu builds and tests, including 18 golden files that compare Rust output
  with the original JavaScript host
- ten consecutive 22-case Windows desktop suites (220 passes, zero skips) and the same suite from a
  relocated PowerShell 5.1 test kit
- Windows packaging, with import checks on both shipping executables

On macOS, the native app was checked by hand: shells, live folders, Duplicate, Stop and close, Save,
Export, and Open with images, Claude and Codex session capture and resume (using local stand-ins),
clipboard shortcuts, board tools, and file drop. Rendered layout is compared with the pre-migration
UI in the [visual parity check](tests/visual/README.md).

Still open before the cutover merges:

- the [Windows 11 checklist](tests/manual/windows11-checklist.md): installer and portable app on a
  clean machine, opening an Electron autosave with images, and the 22-case suite
- selecting and cancelling the native folder picker on macOS

Linux desktop behavior has not been validated. Details, measurements, and limits are in the
[migration plan](docs/rust-migration-plan.md#progress) and the
[Windows baseline](docs/windows-migration-baseline.md). Source lives in `src/`, `crates/`, and
`src-tauri/`; see [the architecture](docs/architecture.md) and `AGENTS.md` for layout and constraints.
