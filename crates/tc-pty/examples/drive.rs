//! Drives a real terminal without the UI: starts a shell, changes its folder, and prints what the
//! host sees. With `--ai`, it also launches stand-ins for Claude Code and Codex and checks that
//! their session IDs are captured, as `scripts/restoration-smoke.cjs` did.
//!
//! ```text
//! cargo build -p tc-hook                        # the AI capture needs the hook next to this binary
//! cargo run -p tc-pty --example drive -- [--shell <shell>] [--ai] [--verbose]
//! ```
//!
//! `--shell` names the shell: `zsh` or `bash` on macOS and Linux (the login shell by default),
//! `powershell`, `pwsh`, or `cmd` on Windows (Windows PowerShell by default). The exit status is 0
//! when every check passed.

use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tc_core::Platform;
use tc_core::workspace::create_card;
use tc_pty::manager::{Config, EventSink, HOOK_POLL_INTERVAL, Integrations, SessionEvent, SessionKey, TerminalManager};
use tc_pty::{DirectoryRequest, PtyBackend, TerminalEvent};

#[cfg(any(windows, test))]
#[path = "../tests/support/cursor.rs"]
mod cursor;

const CLAUDE_ID: &str = "12345678-1234-4321-9876-123456789abc";
const CODEX_ID: &str = "abcdef01-1234-4321-9876-123456789abc";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--fake-cli") {
        return fake_cli(&args[1..]);
    }
    let option = |name: &str| {
        args.iter()
            .position(|arg| arg == name)
            .and_then(|index| args.get(index + 1))
            .cloned()
    };
    let flag = |name: &str| args.iter().any(|arg| arg == name);
    match drive(option("--shell"), flag("--ai"), flag("--verbose")) {
        Ok(()) => {
            println!("PASS");
            ExitCode::SUCCESS
        }
        Err(message) => {
            println!("FAIL: {message}");
            ExitCode::FAILURE
        }
    }
}

struct Driver {
    manager: TerminalManager,
    inbox: Receiver<(SessionKey, SessionEvent)>,
    started: Instant,
    verbose: bool,
    output: String,
    last_poll: Instant,
    #[cfg(windows)]
    cursor: cursor::CursorQuery,
}

impl Driver {
    fn log(&self, kind: &str, text: impl std::fmt::Display) {
        println!("[{:6.2}s] {kind:<10}{text}", self.started.elapsed().as_secs_f64());
    }

    /// Handles events like the host task until `done` holds, or fails after `timeout`.
    fn wait(&mut self, what: &str, timeout: Duration, mut done: impl FnMut(&mut Driver) -> bool) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        loop {
            if self.last_poll.elapsed() >= HOOK_POLL_INTERVAL {
                self.manager.poll_hooks();
                self.last_poll = Instant::now();
            }
            for event in self.manager.take_events() {
                self.show(&event);
            }
            if done(self) {
                return Ok(());
            }
            if Instant::now() > deadline {
                return Err(format!("timed out waiting for {what}"));
            }
            if let Ok((key, event)) = self.inbox.recv_timeout(Duration::from_millis(50)) {
                self.manager.handle(key, event);
            }
        }
    }

    fn show(&mut self, event: &TerminalEvent) {
        match event {
            TerminalEvent::Data { id, data } => {
                self.output.push_str(data);
                // ConPTY inherits the cursor by asking its terminal for a position.
                // Without xterm, the UI-free driver must supply that response itself.
                #[cfg(windows)]
                for _ in 0..self.cursor.feed(data) {
                    self.manager
                        .write(id, cursor::POSITION)
                        .expect("answer the terminal cursor query");
                }
                #[cfg(not(windows))]
                let _ = id;
                if self.verbose {
                    self.log("output", format!("{data:?}"));
                }
            }
            TerminalEvent::Cwd { cwd, .. } => self.log("cwd", format!("{cwd:?}")),
            TerminalEvent::Metadata { metadata, initial, .. } => {
                let session = metadata
                    .session
                    .as_ref()
                    .map(|s| format!("{} {}", s.provider, s.session_id));
                let note = if *initial { " (initial)" } else { "" };
                self.log("metadata", format!("cwd={:?} session={session:?}{note}", metadata.cwd));
            }
            TerminalEvent::Error { message, .. } => self.log("error", message),
            TerminalEvent::Exit { status, .. } => self.log("exit", format!("{status:?}")),
            TerminalEvent::Launch { request, .. } => self.log("launch", format!("{request:?}")),
        }
    }

    fn session(&mut self, id: &str) -> Option<(String, String)> {
        let metadata = self.manager.snapshot().get(id)?;
        metadata
            .session
            .as_ref()
            .map(|session| (session.provider.to_string(), session.session_id.clone()))
    }
}

fn which(name: &str) -> Option<PathBuf> {
    if name.contains(['/', '\\']) {
        return Some(PathBuf::from(name));
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|file| file.is_file())
}

fn quoted(platform: Platform, shell: &str, folder: &str) -> String {
    match (platform.is_windows(), shell) {
        (true, "cmd") => format!("cd /d \"{folder}\"\r"),
        (true, _) => format!("Set-Location -LiteralPath '{}'\r", folder.replace('\'', "''")),
        _ => format!("cd '{}'\r", folder.replace('\'', "'\\''")),
    }
}

fn drive(shell: Option<String>, ai: bool, verbose: bool) -> Result<(), String> {
    let platform = Platform::current();
    let mut config = Config::from_environment();
    let shell = shell.unwrap_or_else(|| {
        if platform.is_windows() {
            "powershell".into()
        } else {
            String::new()
        }
    });
    let mut command = String::new();
    if platform.is_windows() {
        // The manager starts explicit shell launchers directly.
        if shell != "powershell" {
            command.clone_from(&shell);
        }
    } else if !shell.is_empty() {
        let path = which(&shell).ok_or_else(|| format!("{shell} is not installed"))?;
        config.env.insert("SHELL".into(), path.to_string_lossy().into_owned());
    }

    let root = std::env::temp_dir().join(format!("tc drive {}", std::process::id()));
    let target = root.join("folder with spaces 子");
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    // Native shells must discover the stand-ins through ordinary Windows paths.
    let root = dunce::canonicalize(root).map_err(|e| e.to_string())?;
    let target = dunce::canonicalize(target).map_err(|e| e.to_string())?;
    let target_text = target.to_string_lossy().into_owned();

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let hook = exe.parent().and_then(Path::parent).map(|dir| {
        dir.join(if platform.is_windows() {
            "tc-hook.exe"
        } else {
            "tc-hook"
        })
    });
    let hook = hook.filter(|hook| hook.is_file());
    let tools = root.join("tools");
    if ai {
        std::fs::create_dir_all(&tools).map_err(|e| e.to_string())?;
        install_fakes(&tools, &exe, platform)?;
    }
    let integrations: Option<Integrations> = hook.clone().map(|hook| {
        let folder = root.join("shell-integration");
        Box::new(move |shell: &str, platform| tc_pty::integration::prepare(&folder, &hook, platform, shell))
            as Integrations
    });
    if hook.is_none() {
        println!(
            "note: tc-hook was not found next to this example; run `cargo build -p tc-hook` for shell integration"
        );
    }

    let (sender, inbox) = mpsc::channel();
    let sink: EventSink = Arc::new(move |key, event| {
        let _ = sender.send((key, event));
    });
    let manager = TerminalManager::new(config, Box::new(PtyBackend), integrations, sink);
    let mut driver = Driver {
        manager,
        inbox,
        started: Instant::now(),
        verbose,
        output: String::new(),
        last_poll: Instant::now(),
        #[cfg(windows)]
        cursor: cursor::CursorQuery::default(),
    };
    let card =
        serde_json::to_value(create_card(&json!({ "cwd": root.to_string_lossy(), "command": command })).unwrap())
            .unwrap();
    let id = card["id"].as_str().unwrap().to_owned();
    let started = driver
        .manager
        .start(&card, None, None, None)
        .map_err(|e| e.to_string())?;
    driver.log(
        "start",
        format!(
            "pid={:?} shell={} cwd={}",
            started.pid, started.shell, started.metadata.cwd
        ),
    );

    let result = (|| {
        driver.wait("the first prompt", Duration::from_secs(30), |d| {
            if platform.is_windows() {
                d.manager
                    .snapshot()
                    .get(&id)
                    .is_some_and(|metadata| metadata.cwd == started.metadata.cwd)
                    && d.output.contains('>')
            } else {
                !d.output.is_empty()
            }
        })?;
        std::thread::sleep(Duration::from_millis(500));
        driver
            .manager
            .write(&id, &quoted(platform, &shell, &target_text))
            .map_err(|e| e.to_string())?;
        driver.wait("the changed folder", Duration::from_secs(20), |d| {
            d.manager
                .snapshot()
                .get(&id)
                .is_some_and(|metadata| metadata.cwd == target_text)
        })?;
        driver.log("check", "the host recorded the changed folder");
        // The renderer keeps the last reported folder in the card it sends to Duplicate.
        let mut duplicate_card = card.clone();
        duplicate_card["cwd"] = target_text.clone().into();
        let cmd_without_readiness = platform.is_windows() && shell == "cmd";
        let duplicate = Instant::now() + Duration::from_secs(10);
        let choice = loop {
            let choice = match driver.manager.directory(&duplicate_card).map_err(|e| e.to_string())? {
                DirectoryRequest::Ready(choice) => choice,
                DirectoryRequest::Lookup(lookup) => {
                    let current = tc_pty::cwd::process_directory(lookup.pid, lookup.platform);
                    driver.manager.finish_directory(lookup, current)
                }
            };
            if cmd_without_readiness
                || (choice.cwd == target_text && choice.warning.is_none())
                || Instant::now() > duplicate
            {
                break choice;
            }
            driver
                .wait("an idle prompt", Duration::from_millis(200), |_| false)
                .ok();
        };
        driver.log("duplicate", format!("{} {:?}", choice.cwd, choice.warning));
        if choice.cwd != target_text {
            return Err(format!("Duplicate would open {} instead of {target_text}", choice.cwd));
        }
        if cmd_without_readiness {
            // Like the JavaScript host, cmd reports directories but has no idle marker.
            if choice.warning.is_none() {
                return Err("cmd must retain the JavaScript Duplicate review fallback".into());
            }
            driver.log(
                "check",
                "cmd suggests the saved folder for review without claiming prompt readiness",
            );
        } else if choice.warning.is_some() {
            return Err("the integrated shell did not reach an idle prompt for Duplicate".into());
        }
        if ai {
            if hook.is_none() {
                return Err("--ai needs tc-hook".into());
            }
            // Login profiles may rebuild PATH, so put the stand-ins first inside the shell itself, and
            // make sure `claude` resolves to them before running it: never start a real AI CLI.
            let tools_text = tools.to_string_lossy().trim_start_matches(r"\\?\").to_owned();
            let (prepend, check) = if platform.is_windows() {
                let quoted = tools_text.replace('\'', "''");
                (
                    format!("$env:PATH = '{quoted};' + $env:PATH\r"),
                    "if ((Get-Command claude -CommandType Application).Source -eq (Join-Path ($env:PATH.Split(';')[0]) 'claude.cmd')) { 'STAND' + 'IN=OK' }\r".to_owned(),
                )
            } else {
                let quoted = tools_text.replace('\'', "'\\''");
                (
                    format!("export PATH='{quoted}':\"$PATH\"\r"),
                    format!("[ \"$(type -P claude)\" = '{quoted}/claude' ] && echo STAND''IN=OK\r"),
                )
            };
            driver.manager.write(&id, &prepend).map_err(|e| e.to_string())?;
            driver.manager.write(&id, &check).map_err(|e| e.to_string())?;
            driver.wait("the stand-in CLIs on PATH", Duration::from_secs(10), |d| {
                d.output.contains("STANDIN=OK")
            })?;
            driver.manager.write(&id, "claude\r").map_err(|e| e.to_string())?;
            let expected = ("claude".to_owned(), CLAUDE_ID.to_owned());
            driver.wait("the Claude session", Duration::from_secs(30), |d| {
                d.session(&id) == Some(expected.clone())
            })?;
            driver.log("check", "the Claude hook recorded its session");
            driver.manager.write(&id, "codex\r").map_err(|e| e.to_string())?;
            let expected = ("codex".to_owned(), CODEX_ID.to_owned());
            driver.wait("the Codex session", Duration::from_secs(30), |d| {
                d.session(&id) == Some(expected.clone())
            })?;
            driver.log("check", "the Codex session header was captured");
        }
        Ok(())
    })();

    driver.manager.begin_shutdown(Duration::from_secs(5));
    while driver.manager.stopping() > 0 {
        driver.wait("shutdown", Duration::from_millis(100), |_| false).ok();
    }
    let _ = std::fs::remove_dir_all(&root);
    result
}

/// Puts `claude` and `codex` stand-ins on PATH that run this binary with `--fake-cli`.
fn install_fakes(tools: &Path, exe: &Path, platform: Platform) -> Result<(), String> {
    for tool in ["claude", "codex"] {
        if platform.is_windows() {
            let script = format!("@echo off\r\n\"{}\" --fake-cli {tool} %*\r\n", exe.display());
            std::fs::write(tools.join(format!("{tool}.cmd")), script).map_err(|e| e.to_string())?;
        } else {
            let file = tools.join(tool);
            let script = format!(
                "#!/bin/sh\nexec '{}' --fake-cli {tool} \"$@\"\n",
                exe.display().to_string().replace('\'', "'\\''")
            );
            std::fs::write(&file, script).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

/// A stand-in AI CLI. Claude runs its SessionStart hook from `--settings`; Codex prints its
/// session header. Neither calls any service.
fn fake_cli(args: &[String]) -> ExitCode {
    let tool = args.first().map(String::as_str).unwrap_or_default();
    println!("CLI_ARGS:{}", json!(args[1..]));
    if tool == "codex" {
        println!("session id: {CODEX_ID}");
    }
    if tool == "claude"
        && let Some(index) = args.iter().position(|arg| arg == "--settings")
    {
        let settings: Value = std::fs::read_to_string(&args[index + 1])
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        let Some(command) = settings["hooks"]["SessionStart"][0]["hooks"][0]["command"].as_str() else {
            eprintln!("no SessionStart hook in the settings");
            return ExitCode::FAILURE;
        };
        let cwd = std::env::current_dir()
            .map(|cwd| cwd.to_string_lossy().into_owned())
            .unwrap_or_default();
        let payload = json!({ "hook_event_name": "SessionStart", "session_id": CLAUDE_ID, "cwd": cwd, "transcript_path": "MUST_NOT_BE_SAVED" });
        let mut shell = if cfg!(windows) {
            let mut shell = Command::new("cmd.exe");
            shell.args(["/d", "/s", "/c", command]);
            shell
        } else {
            let mut shell = Command::new("/bin/sh");
            shell.args(["-c", command]);
            shell
        };
        let Ok(mut child) = shell.stdin(Stdio::piped()).spawn() else {
            return ExitCode::FAILURE;
        };
        if let Some(mut stdin) = child.stdin.take() {
            use std::io::Write;
            let _ = stdin.write_all(payload.to_string().as_bytes());
        }
        if !child.wait().is_ok_and(|status| status.success()) {
            return ExitCode::FAILURE;
        }
    }
    println!("SESSION_TEST_DONE");
    ExitCode::SUCCESS
}
