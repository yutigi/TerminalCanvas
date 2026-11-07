# Terminal Canvas

A desktop canvas for managing multiple AI terminals. Keep a shell, Claude Code, Codex, Gemini CLI, or your own command in separate movable cards, each with its own project folder.

This initial implementation shares Electron with the neighboring WebCanvas project. WebCanvas integration is planned; it is not included yet.

## Run locally

Use Node.js 22.12+ and npm. Windows 10 1809+ or Windows 11 is the primary target. Native rebuilds may require Python and Visual Studio Build Tools with Desktop development with C++, a Windows SDK, and the Spectre-mitigated libraries required by node-pty.

```powershell
npm install
npm run rebuild
npm start
```

`npm install` needs access to the npm registry and Electron downloads. `npm run rebuild` rebuilds node-pty for Electron's runtime. Rerun it after changing Electron or native dependencies. AI CLIs must already be installed, available on your `PATH`, and authenticated; Terminal Canvas does not install or sign in to them.

The first successful install generates `package-lock.json`; include it in version control. A lockfile could not be generated during initial development because registry access was denied in the development session.

For a dependency-free **layout preview**, run `npm run dev` and visit [localhost:4174](http://127.0.0.1:4174). The preview supports card layout and browser-local recovery; it cannot launch shells, choose native folders, or open/save workspace files. It does not simulate AI output.

## Use the workspace

- Choose **New terminal** or a sidebar profile. Set a name, project folder, and optional shell command, then start it.
- Drag a card's header to move it; drag its lower-right corner to resize. Drag empty canvas or middle-drag to pan. Use Ctrl + scroll to zoom.
- Use **Arrange**, **Fit canvas**, and **Focus** to organize your terminals. Filter the sidebar to find a terminal by name, profile, or folder.
- Use the card's stop/start controls to end or relaunch its shell. Closing a running card asks before stopping it.
- Copy/paste with Ctrl + Shift + C/V. Ctrl + C remains the shell interrupt. Paste respects the terminal's bracketed-paste mode.

On Windows, cards open `cmd.exe` with AutoRun disabled. Use `pwsh` as the launch command for PowerShell, or enter it inside a running terminal. Other systems use the login shell selected by `SHELL`, falling back to Bash; those platforms have not been validated.

| Shortcut | Action |
| --- | --- |
| Ctrl + Shift + N | New terminal |
| Ctrl + S / Ctrl + O | Save / open workspace |
| Ctrl + Shift + F | Toggle focus for the selected terminal |
| / outside a terminal or input | Search terminals |

## Persistence and process lifecycle

Layouts autosave to Electron's user-data directory, normally `%APPDATA%/terminal-canvas/workspace.terminalcanvas` on Windows. **Save workspace** exports a portable `.terminalcanvas` JSON file. A workspace contains names, geometry, profile IDs, project paths, and launch commands. It does not save terminal output, credentials, or process IDs. Keep secrets out of launch commands because those commands are saved in plain text.

Restored cards are stopped until explicitly started. A saved command is never executed merely by importing a workspace. Closing the app stops its managed terminals; running processes cannot survive an app restart. A maximum of 24 cards and 5,000 scrollback lines per terminal bounds the initial workspace.

## Development and validation

| Command | Purpose |
| --- | --- |
| `npm start` | Launch the Electron desktop app |
| `npm run dev` | Serve the layout preview on loopback port 4174 |
| `npm run check` | Check JavaScript syntax and the package manifest |
| `npm test` | Run dependency-free workspace and terminal-manager tests |
| `npm run test:smoke` | Check the desktop renderer, real PTY output, resize, and cleanup; save `.cache/smoke.png` |
| `npm run build` | Package an unsigned Windows portable executable in `release/` |

Core tests use a controlled PTY substitute; the smoke test requires installed desktop dependencies and checks the real native integration. The initial session passed core tests and syntax checks, and served the preview successfully. Desktop startup, native rebuilds, packaging, and visual verification remain unverified because dependencies could not be downloaded and browser automation was unavailable.

Source lives in `src/`, scripts in `scripts/`, tests in `tests/`, and design notes in [docs/architecture.md](docs/architecture.md). `AGENTS.md` is preserved as requested; this README records the tooling added since that guide was created.
