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
- Copy/paste with Ctrl + Shift + C/V. Ctrl + C remains the shell interrupt. Paste respects the terminal's bracketed-paste mode.

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

On Windows, cards open the built-in Windows PowerShell (`powershell.exe`) by default. Optional launch commands run inside PowerShell, except the plain shell launchers described below. Use `pwsh` as the launch command for PowerShell 7 if installed, or `cmd.exe` for Command Prompt. Other systems use the login shell selected by `SHELL`, falling back to Bash; those platforms have not been validated.

### Live terminal folders

A running card shows its shell's last reported current folder, including changes made with `cd`, `Set-Location`, or directory-stack commands. The full path is available on hover. Each terminal tracks its own folder. The configured project folder is still used for every restart and saved workspace; live directory reports are never persisted.

- **Windows PowerShell 5.1** (default) and **PowerShell 7**: a session-local prompt wrapper emits an encoded file URI after commands finish. Profiles and the existing prompt load normally; no profile file is edited. For PowerShell 7, set the launch command to exactly `pwsh` or `pwsh.exe`. Plain `powershell` / `powershell.exe` launchers also receive integration.
- **Command Prompt**: set the launch command to exactly `cmd` or `cmd.exe`. Its process-local `PROMPT` includes a directory report while preserving the existing visible prompt. These plain Windows shell launchers now start directly, so exiting them ends the terminal session.
- **Linux / macOS**: the managed login shell's process directory is queried about once per second, using `/proc/<pid>/cwd` on Linux and `/usr/sbin/lsof` on macOS. This works with native shells such as Bash and Zsh without modifying their startup files. Permission failures or a missing `lsof` report an unavailable directory. These platform adapters have automated coverage but have not been tested on a Linux or macOS desktop.

Before the first report, after a failed lookup, or in a PowerShell non-filesystem location (such as `HKCU:`), the running card shows **Current directory unavailable**. Stopped/restored cards initially show their configured launch folder. Windows updates occur when the prompt returns; a long-running command can leave the last reported folder visible until then. Replacing the PowerShell prompt or cmd `PROMPT` after startup can disable reporting. Nested/remote shells, WSL launched inside Windows, shell launch commands with extra arguments, and applications that maintain their own logical directory are not automatically integrated; Unix polling continues to describe the managed top-level shell. Reports are display metadata, never input or instructions to change a process directory.


| Shortcut | Action |
| --- | --- |
| Ctrl + Shift + N | New terminal |
| Ctrl + Shift + D | Duplicate selected terminal into a fresh shell |
| Ctrl + S / Ctrl + O | Save / open workspace |
| Ctrl + Shift + F | Toggle focus for the selected terminal |
| / outside a terminal or input | Search terminals |
| V / H | Select / hand tool |
| T / N / R / O / L / A / F | Text, sticky note, rectangle, ellipse, line, arrow, frame tool |
| Esc | Return to the Select tool, then clear the selection |
| Ctrl + G / Ctrl + Shift + G | Group / ungroup the selection |
| Delete / Backspace | Delete selected board items |

Single-key and board shortcuts apply only when focus is outside a terminal or text field, so they never reach a running shell.

### Directory tracking and fallback

Windows PowerShell and PowerShell 7 report their FileSystem location at each prompt, including after `cd`, `Set-Location`, and `Push-Location`. Duplicate uses the same directory reports as the live folder display and also requires an idle prompt with no queued keypresses. A submitted command invalidates duplication readiness. Intermediate prompts while pasted commands are draining cannot enable Duplicate in an old folder; the final idle prompt restores it. The integration preserves custom prompt output, `$?`, and native exit status, and does not replace PSReadLine or other input readers.

While a command/AI CLI or nested shell is running, before the first prompt, in a non-filesystem provider such as `HKCU:`, or when the console cannot confirm idle input, Duplicate opens the New terminal dialog with an explanation and the first available folder: the source launch directory, home, then the app's working directory. Review or browse before starting. Deleted/inaccessible directories and stopped cards follow the same flow. Command Prompt updates its live folder label but cannot confirm idle input, so Duplicate uses the review dialog there as well.

On Linux and macOS, Duplicate queries the managed shell's process directory afresh rather than reusing the display's polling cache (`/proc/<pid>/cwd` on Linux, `/usr/sbin/lsof` on macOS). A missing tool or failed lookup opens fallback review. These adapters have automated coverage but have not been validated on those desktops. Directories belonging to independently launched child shells are not tracked; native folder-picker behavior outside Windows remains unvalidated.

## Persistence and process lifecycle

Layouts autosave to Electron's user-data directory, normally `%APPDATA%/terminal-canvas/workspace.terminalcanvas` on Windows. **Save workspace** exports a portable `.terminalcanvas` JSON file. A workspace contains names, geometry, profile IDs, project paths, launch commands, and board items with their text, groups, and connectors. It does not save terminal output, credentials, or process IDs. Keep secrets out of launch commands because those commands are saved in plain text.

Images are copied into `%APPDATA%/terminal-canvas/assets/` under a SHA-256 content name; workspace files store only that name, so a regular saved workspace opened on another computer shows *Image unavailable*. Choose **Export portable copy** in the sidebar to write a separate file with every referenced image embedded. Opening that file copies the images back into the local assets folder, re-hashing each one; the file must be smaller than 64 MB. Image bytes are validated by signature, never by file name, and SVG is not accepted. Unused images are not deleted from the assets folder yet.

Workspace files from version 0.1 (format version 1) open unchanged and are saved as format version 2.

Restored cards are stopped until explicitly started. A saved command is never executed merely by importing a workspace. Closing the app stops its managed terminals; running processes cannot survive an app restart. A maximum of 24 cards, 1,000 board items, and 5,000 scrollback lines per terminal bounds the workspace.

## Development and validation

| Command | Purpose |
| --- | --- |
| `npm start` | Launch the Electron desktop app |
| `npm run dev` | Serve the layout preview on loopback port 4174 |
| `npm run rebuild` | Verify the Windows native binary in Electron, or rebuild when needed |
| `npm run icons` | Regenerate native PNG/ICO icons from `src/assets/logo.svg` using Electron |
| `npm run check` | Check JavaScript syntax and the package manifest |
| `npm test` | Run icon, workspace, board geometry, image asset, minimap, directory-tracking, external-link, terminal-manager, rebuild, renderer, and smoke-output/capture tests; Windows prompt checks invoke built-in PowerShell and optionally PowerShell 7 |
| `npm run test:smoke` | Check live directory changes in Windows PowerShell, PowerShell 7, and cmd; pasted-command safety; Duplicate button/shortcut and process isolation; fallback review, folder-picker paths/cancellation, the desktop renderer, native hyperlink clicks without confirmation (with the OS launch intercepted), minimap navigation, first-click terminal typing, board items (image loading, connector hit testing, note typing, grouping), real PTY output, resize, and cleanup; save `.cache/smoke-creation.png`, `.cache/smoke-links.png`, `.cache/smoke.png`, `.cache/smoke-first-click.png`, `.cache/smoke-board.png`, and `.cache/cwd smoke/*.png` |
| `npm run build` | Package an unsigned Windows portable executable in `release/` |

Terminal-manager tests use a controlled PTY substitute; Windows prompt tests also invoke the real PowerShell executables. The smoke test checks the real native integration and disables background throttling so animation-frame checks continue while another window covers the app. Screenshot capture retries transient `UnknownVizError` failures up to five times; unrelated errors and empty captures fail immediately.

The integrated branch passed `npm run check`, all 96 automated tests, and the complete Windows desktop smoke suite. Real Windows PowerShell 5.1, PowerShell 7, and cmd checks cover live directory changes, spaces, apostrophes, Unicode/reserved characters, independent terminals, unchanged launch folders, failed directory changes, unavailable provider locations, and normal output. Duplication coverage includes queued commands with PSReadLine unavailable, fallback review while a later command is still running, recovery at the final idle prompt, process/output isolation, canceled pickers, and placement at both canvas limits. Prompt regressions cover custom output, failed-command status, strict mode with missing/existing native exit status, and local-machine/localhost UNC decoding. The real Windows picker previously opened at the requested nested folder with spaces, and the refreshed creation screenshot was visually inspected.

The existing hyperlink native-click assertion failed on an earlier smoke run and passed on rerun; first-click focus also has a previously recorded intermittent failure on `main`. The native PTY helper still emits `AttachConsole failed` during shutdown despite a successful smoke result. The last `npm run build` attempt was blocked by `MSB8040: Spectre-mitigated libraries are required for this project`; the required MSVC libraries remain missing and no packaged executable was produced. The default native verification can use the bundled Windows binary; see the source-build prerequisites above. Linux and macOS desktop validation remains unavailable.


Source lives in `src/`, scripts in `scripts/`, tests in `tests/`, and design notes in [docs/architecture.md](docs/architecture.md). `AGENTS.md` is preserved as requested; this README records the tooling added since that guide was created.

The sidebar, browser favicon, desktop window, and Windows executable use the same logo. After editing `src/assets/logo.svg`, run `npm run icons` and include the updated `icon.png` and `icon.ico` assets. Run `npm run icons -- --check` to verify they match the SVG. Restart the desktop app to see a new window icon; rebuild the portable executable to update its file icon.
