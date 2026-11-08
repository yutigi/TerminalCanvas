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
- Use the card's stop/start controls to end or relaunch its shell. Closing a running card asks before stopping it.
- Click a terminal hyperlink to open its HTTP/HTTPS destination directly in your default browser. Unsupported schemes and URLs containing credentials are blocked. Plain-text URL detection is not included.
- Copy/paste with Ctrl + Shift + C/V. Ctrl + C remains the shell interrupt. Paste respects the terminal's bracketed-paste mode. Drag to select terminal text at any canvas zoom; dragging a terminal's scrollbar thumb while zoomed away from 100% still moves at the wrong speed, so use the mouse wheel there.

### Board items

The left canvas toolbar adds items around your terminals. Click to place an item at its default size, or drag to draw it; the tool then returns to Select.

- **Text label** and **sticky note** open for typing immediately. Double-click a label, note, or shape to edit its plain text; press Esc or Ctrl + Enter, or click elsewhere, to finish. An empty text label is removed.
- **Rectangle** and **ellipse** shapes can hold centered text.
- **Line** and **arrow** draw free-standing lines. Start or end a line on any terminal or item to attach it as a connector; attached ends follow the item when it moves. Select a line to drag its end handles and reattach them. Deleting an attached item leaves the line in place with a free end.
- **Frame** draws a titled section. Drag it by its title, which you can double-click to rename. Everything fully inside a frame, including terminals, moves with it. Its empty area still pans the canvas.
- **Image** opens a file picker. You can also paste an image or drop image files onto the canvas. PNG, JPEG, GIF, and WebP files up to 15 MB are supported.
- Shift + click adds or removes elements from the selection; Shift + drag on empty canvas selects every element fully inside the rectangle. Drag any selected element to move the whole selection. Click empty canvas to clear the selection.
- **Ctrl + G** groups the selection so it selects and moves as one unit; **Ctrl + Shift + G** ungroups. Groups can include terminals.
- **Delete** or **Backspace** removes selected board items. Terminals are only removed with their close button, which stops running shells safely.

Board items use one fixed visual style; colors, fonts, and stroke styles are not configurable yet. Undo, copy/paste of items, and nested groups are not implemented.

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
| Ctrl + S / Ctrl + O | Save / open workspace |
| Ctrl + Shift + F | Toggle focus for the selected terminal |
| / outside a terminal or input | Search terminals |
| V / H | Select / hand tool |
| T / N / R / O / L / A / F | Text, sticky note, rectangle, ellipse, line, arrow, frame tool |
| Esc | Return to the Select tool, then clear the selection |
| Ctrl + G / Ctrl + Shift + G | Group / ungroup the selection |
| Delete / Backspace | Delete selected board items |

Single-key and board shortcuts apply only when focus is outside a terminal or text field, so they never reach a running shell.

## Persistence and process lifecycle

Layouts autosave to Electron's user-data directory, normally `%APPDATA%/terminal-canvas/workspace.terminalcanvas` on Windows. **Save workspace** exports a portable `.terminalcanvas` JSON file. A workspace contains names, geometry, profile IDs, project paths, launch commands, optional AI session metadata (provider, UUID, and session folder), and board items with their text, groups, and connectors. It does not save terminal output, credentials, or process IDs. Keep secrets out of launch commands because those commands are saved in plain text. Session IDs identify local conversation history; they do not transfer that history or authentication to another computer.

Images are copied into `%APPDATA%/terminal-canvas/assets/` under a SHA-256 content name; workspace files store only that name, so a regular saved workspace opened on another computer shows *Image unavailable*. Choose **Export portable copy** in the sidebar to write a separate file with every referenced image embedded. Opening that file copies the images back into the local assets folder, re-hashing each one; the file must be smaller than 64 MB. Image bytes are validated by signature, never by file name, and SVG is not accepted. Unused images are not deleted from the assets folder yet.

Workspace files from version 0.1 (format version 1) open unchanged and are saved as format version 2.

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
| `npm run icons` | Regenerate native PNG/ICO icons from `src/assets/logo.svg` using Electron |
| `npm run check` | Check JavaScript syntax and the package manifest |
| `npm test` | Run icon, workspace, board geometry, image asset, minimap, session metadata, recovery, shell integration, directory-tracking, external-link, terminal pointer mapping, terminal-manager, rebuild, node-pty patch, renderer, and smoke-output/capture tests (no npm test framework; Windows prompt checks invoke built-in PowerShell and optionally PowerShell 7) |
| `npm run test:smoke` | Check the desktop renderer, native hyperlink clicks without confirmation (with the OS launch intercepted), minimap navigation, live shell directory changes, first-click terminal typing, terminal text selection, copying, and mouse reports at several zoom levels and in Focus mode, board items (image loading, connector hit testing, note typing, grouping), real PTY output, resize, and cleanup; save `.cache/smoke-links.png`, `.cache/smoke.png`, `.cache/smoke-first-click.png`, and `.cache/smoke-board.png`, and `.cache/cwd smoke/*.png` |
| `npm run test:restoration` | Windows: run two Electron launches with an isolated recovery profile and controlled CLI substitute; verify manual AI capture, actual shell folder changes, hook metadata, close-time flush, stopped cards on reopening, exact-ID resume, and a fresh shell; save `.cache/restoration.png` |
| `npm run build` | Package an unsigned Windows portable executable in `release/` |

After integrating `main` at `41d8408`, syntax checks and all 123 automated tests passed. The two-launch Windows restoration test passed with a clean process exit, including Unicode folders, exact-ID resume, and a fresh shell. Normal shutdown now waits for native PTY cleanup, including terminals stopped just before quitting, with a five-second fallback per stop. The broader desktop smoke passed directory changes and independent saved-folder checks in Windows PowerShell, PowerShell 7, and cmd, then stalled and exceeded a 60-second process timeout. A control run on the unchanged `41d8408` base also passed its directory checks and timed out; the cause remains unconfirmed, and the later UI checks remain unverified for this merge. Packaging was not rerun; the missing source-build prerequisites described below remain unresolved.

Terminal-manager tests use a controlled PTY substitute; the smoke test requires installed desktop dependencies and checks the real native integration. Screenshot capture retries transient `UnknownVizError` failures up to five times, requesting a repaint and waiting 100 ms between attempts. Persistent failures, unrelated errors, and empty captures still fail the test. Earlier base-branch Windows validation passed syntax checks and all 93 automated tests; the combined desktop smoke test includes native GitHub hyperlink clicks, unsafe-scheme rejection, and live shell directory changes. Its terminal selection check, at 45%, 65%, 80%, 100%, and 150% zoom and in Focus mode, also passed with `npm run test:smoke -- --force-device-scale-factor=1.25` and `=1.5`; without the pointer correction, every non-100% zoom case fails. A separate native-click check previously launched the real default browser without confirmation. The board and hyperlink screenshots were visually inspected. In 14 desktop smoke runs on this machine, every run that reached the board checks passed them, but 5 runs failed earlier at the first-click terminal focus assertion. That assertion fails at the same rate on `main` without the board changes (4 of 8 runs), so it is a pre-existing intermittent failure. The native icon comparison against the SVG passed previously. The node-pty `AttachConsole failed` shutdown message no longer appears in smoke runs with the install patch (0 occurrences in 8 runs, compared with 8–9 per run without it). The board check `typing reaches the note editor without triggering tool shortcuts` is also intermittent: it failed in 3 of 8 patched runs and 1 of 5 unpatched runs. The default rebuild command passed previously; forced source compilation is blocked on this machine by missing MSVC Spectre-mitigated libraries. The working-directory hotfix also passed real Windows PowerShell 5.1, PowerShell 7, and cmd directory checks (spaces, Unicode and reserved characters, independent terminals, failed directory changes, unavailable provider locations, and normal output) plus the full desktop smoke test. Follow-up regression checks cover strict-mode prompts with an absent or existing native exit code in both PowerShell versions, and local-machine/localhost UNC URI decoding. Packaging was attempted and failed with `MSB8040: Spectre-mitigated libraries are required for this project`; the required MSVC libraries remain missing. Linux and macOS desktop validation remains unavailable.

Earlier session-restoration branch validation (before integrating main):

Core tests use a controlled PTY substitute; the smoke tests require installed desktop dependencies and check the real native integration. Screenshot capture retries transient `UnknownVizError` failures up to five times, requesting a repaint and waiting 100 ms between attempts. Persistent failures, unrelated errors, and empty captures still fail the test. Session-restoration validation passed syntax checks, all 86 automated tests (including app-quit, renderer-crash, output misattribution, stale startup responses, Unicode hook input, and Bash login-profile recovery), the default rebuild, and the focused two-launch restoration smoke test. The desktop restoration test now uses Thai, Chinese, and emoji folder names and verifies that printing a resume-command example cannot replace the captured ID. Its screenshot was visually inspected. The restoration smoke uses local substitutes rather than paid AI requests. Claude Code 2.1.319's help was inspected; Codex was unavailable on this shell's PATH, so its live provider integration remains unverified. Bash login/profile behavior has regression coverage under Git Bash; native Linux/macOS integration remains unverified.

The general desktop smoke test failed on separate runs at `scripts/smoke.cjs:65` (minimap camera remained 50) and `scripts/smoke.cjs:137` (connector selection was `[]`, expected `['wire']`). Earlier validation also recorded intermittent first-click focus failures on `main`; the cause of these newer smoke failures is unconfirmed. Native shutdown continues to print node-pty `AttachConsole failed`; an early restoration smoke run also exited abnormally after its assertions, while the final focused run passed with natural shell exit between resume and restart. Packaging was attempted and failed with `MSB8040: Spectre-mitigated libraries are required for this project`; a packaged executable remains unverified.

Source lives in `src/`, scripts in `scripts/`, tests in `tests/`, and design notes in [docs/architecture.md](docs/architecture.md). `AGENTS.md` is preserved as requested; this README records the tooling added since that guide was created.

The sidebar, browser favicon, desktop window, and Windows executable use the same logo. After editing `src/assets/logo.svg`, run `npm run icons` and include the updated `icon.png` and `icon.ico` assets. Run `npm run icons -- --check` to verify they match the SVG. Restart the desktop app to see a new window icon; rebuild the portable executable to update its file icon.
