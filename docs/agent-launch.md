# Opening terminals from agents and scripts

Any program can ask Terminal Canvas for a new terminal: an AI agent in any harness (Claude Code,
Codex CLI, Gemini CLI, GitHub Copilot CLI, Aider, Cursor, and others), an editor task, a CI script,
or you. The request goes through `tc-hook new-terminal`, the sidecar installed next to the app. Nothing
in the protocol is specific to one agent.

- **Inside a Terminal Canvas terminal**, the new card opens beside the terminal that asked, joined to
  it by an arrow, and starts immediately.
- **Outside the canvas** (another terminal app, an editor, a background job), the request goes to the
  running app. The card opens beside the card named by `--parent`, joined by an arrow, or in view on
  its own when no parent is named or that card no longer exists.

The caller learns the new card's ID, or why nothing opened, and can follow the new terminal's output
through a log file.

The arrow is an ordinary board connector: move, restyle, delete, or undo it like any other. Undo
never closes the terminal.

## Environment

Every terminal the app starts has:

| Variable | Meaning |
| --- | --- |
| `TERMINAL_CANVAS` | `1` inside any Terminal Canvas terminal |
| `TC_HOOK` | Full path to `tc-hook` |
| `TC_LAUNCH_DIR` | This terminal's private request folder |
| `TC_CARD_ID` | This terminal's card ID, for `--parent` |

All shells get them, including Command Prompt. A harness that filters the environment it passes to
tool commands must let these through; otherwise the request goes to the app inbox and opens without
an arrow, unless you pass `--parent "$TC_CARD_ID"` from a process that still has it.

Outside the canvas, `tc-hook` finds the running app through its data folder: `%APPDATA%\terminal-canvas`
on Windows, `~/Library/Application Support/terminal-canvas` on macOS, `~/.config/terminal-canvas` on
Linux. Set `TERMINAL_CANVAS_DATA` or pass `--data-dir` to use another one. `tc-hook` is next to the
app executable (`tc-hook.exe` beside `Terminal Canvas.exe` on Windows).

## Command

```text
tc-hook new-terminal [--profile <shell|claude|codex|gemini|custom>] [--title <title>]
                     [--cwd <folder>] [--command <command>] [--parent <card id>]
                     [--data-dir <folder>] [--log] [--timeout <seconds>] [--no-wait] [--json]
```

| Option | Meaning |
| --- | --- |
| `--profile` | Card profile; `shell` by default. It sets the card's mark and default command. |
| `--title` | Card name; defaults to the profile name |
| `--cwd` | Folder to start in, relative to the current directory; defaults to the current directory |
| `--command` | Command typed into the new terminal's shell; defaults to the profile's command (none for `shell`) |
| `--parent` | Card ID to open beside; sends the request to the app inbox even from inside a terminal |
| `--data-dir` | App data folder to use outside the canvas |
| `--log` | Ask the app to write the new terminal's output to a plain-text log, and print its path |
| `--timeout` | Seconds (1 to 600, default 10) to wait for the app to take the request, and again for its answer |
| `--no-wait` | Return once the request is written, without the app's answer |
| `--json` | Print one JSON object instead of text |

The command is typed into the new terminal's shell, so write it for that shell: PowerShell on Windows
by default, otherwise the login shell. Title, folder, and command follow the New terminal dialog's
limits (100, 4,096, and 2,000 characters).

## Result

`tc-hook` waits until the new terminal has started, or failed to, and reports what happened:

| Exit | `--json` status | Meaning |
| --- | --- | --- |
| 0 | `opened` | The card opened and its terminal started; `card` is its ID |
| 0 | `queued` | `--no-wait`: the request was written; nothing is known yet |
| 1 | `usage` / `unavailable` | Bad options, no running app to ask, or the request folder could not be written |
| 2 | `refused` | The request was invalid: unknown profile, missing folder, invalid parent, or a value over the limits |
| 2 | `failed` | The app could not open it, for example at the 24-terminal limit or when the terminal failed to start |
| 3 | `timeout` | The app did not take the request in time; it was withdrawn and nothing opens |
| 4 | `unconfirmed` | The app took the request but did not answer in time; a terminal may still open |

With `--json`:

```json
{"status":"opened","id":"<request id>","card":"<new card id>","parent":"<parent card id>","via":"terminal",
 "log":"<path>","request":{"profile":"codex","title":"Reviewer","cwd":"D:\\repo","command":"codex","reply":true,"log":true}}
```

`via` is `terminal` for a terminal's own inbox and `app` for the app inbox. `request` echoes what was
sent; `reply` is `false` with `--no-wait`, and `parent` appears there when `--parent` named one.
The top-level `parent` is the card the new one actually opened beside, as the app reports it: it is
absent when the card opened on its own, including when the named parent no longer exists, and with
`--no-wait` from the app inbox, since nothing is known yet. Failures carry `error` instead of `card`.

The new card's ID can be passed as `--parent` later, so an orchestrating program can build chains of
terminals from outside the canvas.

## Following a terminal's output

With `--log`, the app writes everything the new terminal prints to the file named by `log`, as plain
text: colors and other escape sequences are removed, a line rewritten in place (by a backspace, a
carriage return, a progress meter, or a shell's line editor) keeps its final text, a line wider than
the terminal stays one line, and moves to another row become line breaks. The line being written is
added once it ends, once the output pauses for about a second and a half (so a prompt waiting for
input appears), or when the process exits. Text the log already holds is never changed, so a later
rewrite of it continues on a new line. The log starts with the terminal's first output and grows as
it runs. When the process ends, the app adds a
last line:

```text
[Terminal Canvas: the process exited with code 0]
```

So a program can wait for a result by reading the file until that line appears:

```bash
report=$("$TC_HOOK" new-terminal --title "Tests" --command 'npm test; exit $?' --log --json)
log=$(printf '%s' "$report" | sed -n 's/.*"log":"\([^"]*\)".*/\1/p')
until grep -q '^\[Terminal Canvas: the process exited' "$log" 2>/dev/null; do sleep 2; done
tail -n 40 "$log"
```

The command is typed into an interactive shell, so the process that ends is that shell. End the
command with `exit` (`npm test; exit $?`, or `npm test; exit $LASTEXITCODE` in PowerShell) when the
caller should see it finish; otherwise the terminal stays open for you to use.

A log keeps the first 16 MB of output; after that it notes that it stopped, and the terminal keeps
running. Logs live in the request folder: a log requested from inside a terminal is deleted when that
terminal ends, and logs in the app inbox are deleted when the app next starts. Copy anything you want
to keep. Output is only written to disk when a request asks for a log.

## Examples

```bash
# Bash, zsh, or Git Bash (the shell Claude Code's Bash tool uses on Windows)
"$TC_HOOK" new-terminal --profile codex --title "Review" --command 'codex "Review the diff on this branch"'
```

```powershell
# PowerShell
& $env:TC_HOOK new-terminal --title "API tests" --cwd ..\api --command "npm test" --log --json
```

```bat
:: Command Prompt
"%TC_HOOK%" new-terminal --title "Build" --command "cargo build"
```

```bash
# Outside the canvas, beside a card whose ID a process inside it reported
"/path/to/tc-hook" new-terminal --parent "$PARENT_CARD_ID" --title "Worker" --json
```

## Teaching an agent about it

Agents only use the command if their instructions mention it. Paste this into the instruction file
your harness reads (`AGENTS.md` for Codex and many others, `CLAUDE.md`, `GEMINI.md`,
`.github/copilot-instructions.md`, or a skill):

```markdown
## Terminal Canvas

When `TERMINAL_CANVAS=1`, you run inside a Terminal Canvas terminal. To open another terminal on the
canvas (a fresh agent session, a long-running server, a parallel task), run
`"$TC_HOOK" new-terminal --title "<name>" --cwd "<folder>" --command "<command>" --json`.
Use `--profile claude|codex|gemini` to start that agent with its default command. The new terminal
opens beside yours, linked by an arrow, and starts immediately. Status `opened` (exit 0) gives the
new card's ID; any other status means nothing opened (for `unconfirmed`, one may still open), so
tell the user. To follow its output, add `--log` and read the file named by `log`; a line starting
with `[Terminal Canvas: the process exited` marks the end. Never open more terminals than the task
needs.
```

The Claude Code `session-handover` skill uses this command when it detects Terminal Canvas.

## Sandboxes

Each terminal's request folder is in the system temporary folder, which agent sandboxes commonly allow
writing to. If a sandbox still blocks the write, `tc-hook` exits 1 (`unavailable`) and names the
folder. Approve the command, or allow writes to `TC_LAUNCH_DIR` (outside the canvas, to the app data
folder's `launch-requests`).

A new terminal is an ordinary terminal: it does **not** inherit the requesting agent's sandbox,
approval rules, or permission mode. An agent allowed to run `tc-hook new-terminal` can therefore run
commands outside its sandbox. If you rely on a harness sandbox, make that harness ask before running
`tc-hook`, for example with a rule that requires approval for the command.

## Security

Requests travel only through owner-only folders, never through terminal output, so viewing a file or
a remote session cannot open a terminal. Any program running as you can write those folders, just as
it could start processes itself; sandboxed agents are the exception described above. The app
validates each request again, takes each one once, opens at most four per inbox every half second,
and discards requests left while it was closed. Answers and logs are written only for requests the
app took from an inbox, into that same inbox; the UI never chooses a path. A terminal's request
folder is removed when that terminal ends.
