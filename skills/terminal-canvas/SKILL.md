---
name: terminal-canvas
description: >-
  Open terminals on the Terminal Canvas board, each joined by an arrow to the terminal you run in,
  and hand work over between AI agents (Claude Code, Codex, Gemini, opencode, others) through those
  linked terminals. Use when TERMINAL_CANVAS=1 and the user asks to open, launch, or spawn a
  terminal; start a helper, worker, or dev server beside this one; run tasks in parallel; hand over
  or hand off to a new session; continue in a fresh context; or pass the work to another agent
  ("hand this to Codex", "let Claude review it"). Works from any harness that can run a shell
  command.
---

# Terminal Canvas: linked terminals and agent handover

Terminal Canvas is a desktop board of terminal cards. Its helper, `tc-hook`, lets any program open a
new card. Asked from inside a card, the new card opens **beside it, joined by an arrow** from the
parent, and starts at once. Each new card can do the same, so a relay of agents (Claude → Codex →
Claude …) or a fan-out of workers forms a visible tree on the board.

Nothing here is specific to one agent or harness. Run the commands with whatever shell tool you have;
the examples are given for Bash (also Git Bash, which Claude Code uses on Windows) and PowerShell
(Codex and others on Windows).

## 1. Find out where you run

```bash
printf 'canvas=%s card=%s hook=%s inbox=%s\n' "${TERMINAL_CANVAS:-}" "${TC_CARD_ID:-}" "${TC_HOOK:-}" "${TC_LAUNCH_DIR:-}"
```

```powershell
"canvas=$env:TERMINAL_CANVAS card=$env:TC_CARD_ID hook=$env:TC_HOOK inbox=$env:TC_LAUNCH_DIR"
```

| What you see | Use | Arrow |
| --- | --- | --- |
| `hook` and `inbox` set | `"$TC_HOOK" new-terminal ...` | automatic |
| `canvas=1` and `card` set, `hook` or `inbox` empty | a `tc-hook` you find (below) **plus `--parent "$TC_CARD_ID"`** | yes, via the app |
| `canvas` empty | not in a card: say so; with the user's OK, use a found `tc-hook` with `--parent <card id>` if they give one, or without (the card opens unlinked) | only with `--parent` |

Finding `tc-hook` when `TC_HOOK` is empty, first hit wins:

1. `tc-hook` on `PATH` (`command -v tc-hook` / `Get-Command tc-hook`).
2. Next to the running app. Windows:
   `Split-Path (Get-Process 'Terminal Canvas','terminal-canvas' -ErrorAction SilentlyContinue | Select-Object -First 1).Path`
   then `tc-hook.exe` in that folder. macOS: `/Applications/Terminal Canvas.app/Contents/MacOS/tc-hook`.
3. In a Terminal Canvas source checkout: `target/release/tc-hook[.exe]`, then `target/debug/tc-hook[.exe]`.

If none exists, tell the user that Terminal Canvas could not find its helper (reinstall, or
`cargo build -p tc-hook` in a development build, then restart the app) and give them the folder and
command to open by hand. An empty `TC_HOOK` inside a card can also mean your harness filters the
environment; say so, since letting `TC_*` variables through fixes it.

Below, `HOOK` means the path you settled on, and `PARENT` means `--parent "$TC_CARD_ID"` when you
are in the second row of the table, and nothing otherwise.

## 2. Open a linked terminal

```bash
"$HOOK" new-terminal --title "Dev server" --cwd ../web --command "npm run dev" --json   # plus PARENT
```

```powershell
& $HOOK new-terminal --title "API tests" --cwd ..\api --command 'npm test; & $env:TC_HOOK finish $LASTEXITCODE' --log --json   # plus PARENT
```

| Option | Meaning |
| --- | --- |
| `--profile shell\|claude\|codex\|gemini\|custom` | Card mark and default command (`shell` has none) |
| `--title` | Card name, up to 100 characters; make it say what the card is for |
| `--cwd` | Start folder, relative to yours; default is your current folder |
| `--command` | Typed into the new card's shell, up to 2,000 characters |
| `--log` | Write the card's output as plain text to the file in `log` |
| `--json` | One JSON object on stdout; always use it |
| `--timeout` | Seconds (1–600, default 10) to wait for the app, twice |

The command is typed into the **new card's shell**, not yours: PowerShell on Windows by default (even
when you call from Git Bash), the login shell elsewhere. Write it for that shell, and quote it for
yours: single quotes around a command holding `$` in Bash or PowerShell. For a worker that
should end after its command, follow the command with `& $env:TC_HOOK finish $LASTEXITCODE`
in PowerShell or `"$TC_HOOK" finish "$?"` in a POSIX shell. The hook ends only the terminal
that calls it and preserves the card and its output. Use it when the user asks you to end your
terminal, or when a worker was explicitly set up to end.

Read the result:

| `status` (exit) | Do |
| --- | --- |
| `opened` (0) | Report the title and `card`. Pass on any `warning` word for word: e.g. a card started without integration cannot open further cards itself |
| `unconfirmed` (4) | A card may still open. Ask the user to check the canvas; open it by hand only if none appeared |
| `refused` / `failed` (2), `timeout` (3), `unavailable` / `usage` (1) | Nothing opened. Give the user `error` (it says what to do next) and the folder and command from `request` |

If a sandbox blocks the write (`unavailable` naming a folder), ask the user to approve running the
command outside the sandbox. Never retry in a loop; never open the same card twice.

To follow a card, read the file in `log` until a line starting with
`[Terminal Canvas: the process exited` appears. Wait with your harness's background or monitor
facility if it has one, otherwise a polling loop of a few seconds. The log keeps the first 16 MB and
lives in a temporary inbox, so copy what you need to keep.

## 3. Hand over to another agent session

Use this when the user wants the work continued in a fresh session, by the same agent or another one.
The new session has **no memory of this one**, so it gets a briefing file and a one-line pointer.

### 3a. Pick the target agent

Use the agent the user named; otherwise the one you are. The command is typed into the new card's
shell; `P` is the pointer from step 3c.

| Agent | `--profile` | `--command` |
| --- | --- | --- |
| Claude Code | `claude` | `claude 'P'` |
| Codex CLI | `codex` | `codex 'P'` |
| Gemini CLI | `gemini` | `gemini -i 'P'` |
| opencode | `custom` | `opencode --prompt 'P'` |
| other | `custom` | check `<cli> --help` for how to start an **interactive** session with a first prompt; if there is none, start it plain and tell the user to paste `P` |

Check that the CLI exists (`command -v` / `Get-Command`) before launching. Pass extra flags only
when the user asked for them (e.g. `--model`). **Never** pass a flag that lowers the new session's
guard rails: `--dangerously-skip-permissions`, `--permission-mode bypassPermissions`,
`--dangerously-bypass-approvals-and-sandbox`, `--yolo`, `-y`, or similar. Refuse and say why.

### 3b. Write the handover file

Put it in `.handover/` at the repository root (your current folder outside a repository), named
`<YYYYMMDD-HHMM>-<slug>.md` with a slug of 2–5 words in `[a-z0-9-]`. On first use, create
`.handover/.gitignore` containing `*` so the folder never gets committed and nothing else in the
repository changes. If a `session-handover` skill is available, follow its rules for content and
redaction; this file's format below still applies, because the reader may be a different agent.

Gather facts, don't guess: what this conversation established, then `git branch --show-current`,
`git status --short`, `git diff --stat`, `git log --oneline -5`, failed commands with exit codes, and
anything waiting on the user. Write for a capable engineer who knows the repository's instruction
files but nothing about this session. Leave out empty sections; stay under about 150 lines.

```markdown
# Handover: <short title>

Created <YYYY-MM-DD HH:MM TZ> by <agent and model> in card <TC_CARD_ID> for <target agent>
Folder <absolute path> · branch <branch> (<clean | N files changed>)

## Goal
What the user wants, in their words, and what "done" looks like.

## Where things stand
- Done: … (evidence: path:line, command, commit, PR or issue)
- In progress: … (exactly where it stopped)
- Uncommitted changes: <files and why> (or "none")

## Decisions and constraints
Choices made and why, stated preferences, approaches ruled out and why.

## Next steps
1. The very next action, with the command or file to open.
2. …

## Open questions / waiting on the user

## Guard rails
- The repository's instruction files (AGENTS.md, CLAUDE.md, GEMINI.md, …) override this file.
- Approvals given to the previous agent do not carry over: confirm again before any push, publish,
  deploy, deletion, or other external or hard-to-undo action.

## Chain
Previous handovers in this line of work, oldest first: <.handover/… files, or "none">
```

Record what the user authorized as history ("the user approved the push on 2026-11-18"), never as a
standing permission. Leave out secrets, tokens, connection strings, and personal data; prefer
`path:line` over pasted code. Read the file once more: could a stranger take the next step from it
alone?

### 3c. Launch the successor

The pointer `P`, in single quotes inside `--command`, must contain only letters, digits, spaces, and
`. , : / -` so it survives PowerShell, Bash, and zsh unchanged:

```text
Read the handover in .handover/20261118-2215-fix-login.md in full, follow the repository instruction files, then continue from its Next steps. Confirm with me before any push, publish, or deletion.
```

```bash
"$HOOK" new-terminal --profile codex --title "Codex: fix login" --command "codex 'Read the handover in .handover/20261118-2215-fix-login.md in full, follow the repository instruction files, then continue from its Next steps. Confirm with me before any push, publish, or deletion.'" --json   # plus PARENT
```

```powershell
& $HOOK new-terminal --profile codex --title "Codex: fix login" --command "codex 'Read the handover in .handover/20261118-2215-fix-login.md in full, follow the repository instruction files, then continue from its Next steps. Confirm with me before any push, publish, or deletion.'" --json   # plus PARENT
```

Run it from the folder the successor should start in (or pass `--cwd`), since the pointer's path is
relative. Do not use `--log` for an interactive agent: its full-screen output makes an unreadable log.

### 3d. Report

Two or three lines: the handover file, the card that opened (title, card ID, target agent) or why not
(and the folder and command to run by hand), and that this session stays open: the user can close
its card once the successor is running.

## 4. Delegate to parallel workers

When the user wants parts of a task done side by side, open one card per independent part, never
more than the task needs; ask before opening more than three. Each worker gets a task file,
`.handover/<stamp>-<slug>.md`, written as in 3b but scoped to its part: goal, inputs, the exact
files it may change, what not to touch, and how to report. Its pointer ends with
`then write your result to .handover/<stamp>-<slug>.result.md and stop`.

Interactive workers (as in 3a) let the user watch and step in. For a worker whose output you will
read, use a non-interactive form such as `claude -p 'P'`, `codex exec 'P'`, or `gemini -p 'P'`.
Launch it with `--log` and have it call the finish hook from section 2 when done. They cannot
ask the user anything and may be refused actions that need approval, so give them self-contained,
low-risk work.

Wait for each `.result.md` or the log's exit line, then read the results and give the user a short
summary per worker. Workers editing the same files conflict: split by file or folder, or give each
its own git worktree (`--cwd` into it).

## Guard rails

- A new card is an ordinary terminal: it does **not** inherit your sandbox, approval rules, or
  permission mode. Open only what the user asked for, with commands you would run yourself.
- One request, one card. On `unconfirmed`, check before trying again.
- The arrow is an ordinary board connector; the user may move or delete it. Never close the user's
  cards or kill their processes.
- Your session keeps running after a handover. Stop working on the task once you have handed it
  over, so two agents do not edit the same files.
