//! Real terminals: the portable-pty backend driven through the manager, as the host will drive it.

use std::sync::Arc;
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tc_core::workspace::create_card;
use tc_pty::PtyBackend;
use tc_pty::manager::{Config, EventSink, SessionEvent, SessionKey, TerminalManager};

struct Live {
    manager: TerminalManager,
    inbox: Receiver<(SessionKey, SessionEvent)>,
    events: Vec<Value>,
    /// Every `data` event so far, joined.
    output: String,
}

impl Live {
    fn new(config: Config) -> Live {
        let (sender, inbox) = mpsc::channel();
        let sink: EventSink = Arc::new(move |key, event| {
            let _ = sender.send((key, event));
        });
        let manager = TerminalManager::new(config, Box::new(PtyBackend), None, sink);
        Live {
            manager,
            inbox,
            events: Vec::new(),
            output: String::new(),
        }
    }

    /// Handles process events, as the host task does, until `done` holds or `timeout` passes.
    fn pump(&mut self, timeout: Duration, mut done: impl FnMut(&Live) -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            for event in self.manager.take_events() {
                let event = serde_json::to_value(event).unwrap();
                if event["type"] == "data" {
                    self.output.push_str(event["data"].as_str().unwrap());
                } else {
                    self.events.push(event);
                }
            }
            if done(self) {
                return true;
            }
            let Some(left) = deadline.checked_duration_since(Instant::now()) else {
                return false;
            };
            if let Ok((key, event)) = self.inbox.recv_timeout(left.min(Duration::from_millis(50))) {
                self.manager.handle(key, event);
            }
        }
    }

    /// Handles events until every stopped terminal has exited or timed out.
    fn settle(&mut self, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        while self.manager.stopping() > 0 && Instant::now() < deadline {
            self.pump(Duration::from_millis(50), |_| false);
        }
    }

    /// Whether the end of the output contains `text`. Markers are printed last, and searching only the
    /// tail keeps waiting on a flood of small reads cheap.
    #[cfg_attr(windows, allow(dead_code))]
    fn has(&self, text: &str) -> bool {
        let mut start = self.output.len().saturating_sub(512);
        while !self.output.is_char_boundary(start) {
            start -= 1;
        }
        self.output[start..].contains(text)
    }

    #[cfg_attr(windows, allow(dead_code))]
    fn exit(&self) -> Option<&Value> {
        self.events.iter().find(|event| event["type"] == "exit")
    }

    /// The number after `child=` in the output, once a character follows it.
    fn child_pid(&self) -> Option<u32> {
        let after = self.output.split("child=").nth(1)?;
        let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
        (after.len() > digits.len() && !digits.is_empty()).then(|| digits.parse().ok())?
    }
}

fn card(options: Value) -> (Value, String) {
    let card = serde_json::to_value(create_card(&options).unwrap()).unwrap();
    let id = card["id"].as_str().unwrap().to_owned();
    (card, id)
}

#[cfg(unix)]
mod unix {
    use super::*;
    use tc_core::js::utf16_len;
    use tc_pty::manager::HIGH_WATER;

    fn sh() -> Live {
        let mut config = Config::from_environment();
        config.env.insert("SHELL".into(), "/bin/sh".into());
        config.env.insert("PS1".into(), "$ ".into());
        Live::new(config)
    }

    // Typed commands are echoed, so markers are printed with `printf` pieces that the echo does
    // not contain.

    #[test]
    fn a_shell_runs_input_and_reports_its_exit_code() {
        let mut live = sh();
        let (card, id) = card(json!({}));
        let started = live.manager.start(&card, None, None, None).unwrap();
        assert!(started.pid.is_some());
        live.manager.write(&id, "echo tc-$((6*7))\r").unwrap();
        assert!(
            live.pump(Duration::from_secs(10), |live| live.has("tc-42")),
            "{}",
            live.output
        );
        live.manager.write(&id, "printf '\\345\\255\\220\\n'\r").unwrap();
        assert!(
            live.pump(Duration::from_secs(10), |live| live.has("子")),
            "UTF-8 output: {}",
            live.output
        );
        live.manager.write(&id, "exit 3\r").unwrap();
        assert!(
            live.pump(Duration::from_secs(10), |live| live.exit().is_some()),
            "{}",
            live.output
        );
        assert_eq!(
            *live.exit().unwrap(),
            json!({ "type": "exit", "id": id, "exitCode": 3 })
        );
        assert!(!live.manager.is_running(&id));
    }

    #[test]
    fn a_shell_killed_by_a_signal_reports_code_zero_and_the_signal() {
        let mut live = sh();
        let (card, id) = card(json!({}));
        live.manager.start(&card, None, None, None).unwrap();
        live.manager.write(&id, "kill -KILL $$\r").unwrap();
        assert!(
            live.pump(Duration::from_secs(10), |live| live.exit().is_some()),
            "{}",
            live.output
        );
        let exit = live.exit().unwrap();
        assert_eq!((exit["exitCode"].as_i64(), exit["signal"].as_i64()), (Some(0), Some(9)));
    }

    #[test]
    fn resize_reaches_the_terminal() {
        let mut live = sh();
        let (card, id) = card(json!({}));
        live.manager
            .start(&card, Some(&json!(90)), Some(&json!(30)), None)
            .unwrap();
        live.manager.resize(&id, &json!(100), &json!(40)).unwrap();
        live.manager.write(&id, "stty size\r").unwrap();
        assert!(
            live.pump(Duration::from_secs(10), |live| live.has("40 100")),
            "{}",
            live.output
        );
        live.manager.stop_all();
    }

    #[test]
    fn stop_ends_the_shell_and_its_foreground_job() {
        use rustix::process::{Pid, test_kill_process};
        let mut live = sh();
        let (card, id) = card(json!({}));
        live.manager.start(&card, None, None, None).unwrap();
        live.manager
            .write(&id, "sh -c 'printf \"ch%s=%s\\n\" ild $$; exec sleep 300'\r")
            .unwrap();
        assert!(
            live.pump(Duration::from_secs(10), |live| live.child_pid().is_some()),
            "{}",
            live.output
        );
        let child = Pid::from_raw(live.child_pid().unwrap() as i32).unwrap();
        assert!(test_kill_process(child).is_ok(), "the job is running");
        live.manager.stop(&id);
        assert!(!live.manager.is_running(&id));
        live.settle(Duration::from_secs(10));
        assert_eq!(live.manager.stopping(), 0, "the shell's exit was observed");
        let gone = (0..100).any(|_| {
            std::thread::sleep(Duration::from_millis(50));
            test_kill_process(child).is_err()
        });
        assert!(gone, "the foreground job must not outlive Stop");
        assert!(live.exit().is_none(), "a stopped terminal reports no exit to the UI");
    }

    #[test]
    fn unacknowledged_output_pauses_the_reader_until_acknowledged() {
        let mut live = sh();
        let (card, id) = card(json!({}));
        live.manager.start(&card, None, None, None).unwrap();
        live.manager
            .write(&id, "yes | head -c 2000000; printf '\\ntc-flood-%s\\n' done\r")
            .unwrap();
        live.pump(Duration::from_secs(2), |_| false);
        let held = utf16_len(&live.output);
        assert!(held > HIGH_WATER, "output flows up to the high watermark ({held})");
        assert!(
            held < HIGH_WATER + 2 * 65_536,
            "reading pauses without acknowledgments ({held})"
        );
        // Acknowledge output as the renderer does once it has written it.
        let deadline = Instant::now() + Duration::from_secs(60);
        let mut acknowledged = 0;
        while !live.has("tc-flood-done") && Instant::now() < deadline {
            let total = utf16_len(&live.output);
            while acknowledged < total {
                let step = (total - acknowledged).min(1024 * 1024);
                live.manager.acknowledge(&id, &json!(step));
                acknowledged += step;
            }
            live.pump(Duration::from_millis(100), |live| live.has("tc-flood-done"));
        }
        assert!(live.has("tc-flood-done"), "acknowledged output resumes reading");
        assert!(utf16_len(&live.output) >= 2_000_000);
        live.manager.stop_all();
    }
}

#[cfg(windows)]
mod windows {
    use super::*;

    fn which(program: &str) -> Option<std::path::PathBuf> {
        let path = std::env::var_os("PATH")?;
        std::env::split_paths(&path)
            .map(|dir| dir.join(program))
            .find(|file| file.is_file())
    }

    /// PowerShell 5.1, PowerShell 7 (when installed), and cmd report a changed folder, and the
    /// PowerShell integration reports an idle prompt.
    #[test]
    fn windows_shells_report_directories_and_readiness() {
        let target = std::env::temp_dir()
            .join(format!("tc pty {}", std::process::id()))
            .join("子");
        std::fs::create_dir_all(&target).unwrap();
        let target = target.to_string_lossy().into_owned();
        for command in ["", "pwsh", "cmd"] {
            if command == "pwsh" && which("pwsh.exe").is_none() {
                continue;
            }
            let mut live = Live::new(Config::from_environment());
            let (card, id) = card(json!({ "command": command }));
            live.manager.start(&card, None, None, None).unwrap();
            let cd = if command == "cmd" {
                format!("cd /d \"{target}\"\r")
            } else {
                format!("Set-Location -LiteralPath '{target}'\r")
            };
            live.manager.write(&id, &cd).unwrap();
            let reported = |live: &Live| {
                live.events
                    .iter()
                    .any(|e| e["type"] == "cwd" && e["cwd"] == target.as_str())
            };
            assert!(
                live.pump(Duration::from_secs(30), reported),
                "{command:?} reports {target}\n{}",
                live.output
            );
            if command != "cmd" {
                // The readiness marker follows the directory report in the same prompt.
                let deadline = Instant::now() + Duration::from_secs(10);
                let choice = loop {
                    live.pump(Duration::from_millis(50), |_| false);
                    let tc_pty::DirectoryRequest::Ready(choice) = live.manager.directory(&card).unwrap() else {
                        panic!("Windows answers from the prompt report")
                    };
                    if choice.warning.is_none() || Instant::now() > deadline {
                        break choice;
                    }
                };
                assert_eq!(
                    choice.cwd, target,
                    "{command:?} is idle at a prompt: {:?}",
                    choice.warning
                );
            }
            live.manager.stop_all();
        }
    }

    #[test]
    fn stop_ends_child_processes_through_the_job_object() {
        let mut live = Live::new(Config::from_environment());
        let (card, id) = card(json!({}));
        live.manager.start(&card, None, None, None).unwrap();
        live.manager
            .write(&id, "$p = Start-Process -PassThru -NoNewWindow ping -ArgumentList '-n','300','127.0.0.1'; 'ch' + 'ild=' + $p.Id\r")
            .unwrap();
        assert!(
            live.pump(Duration::from_secs(30), |live| live.child_pid().is_some()),
            "{}",
            live.output
        );
        let child = live.child_pid().unwrap();
        live.manager.stop(&id);
        live.settle(Duration::from_secs(10));
        std::thread::sleep(Duration::from_millis(500));
        let listing = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {child}"), "/NH"])
            .output()
            .unwrap();
        let alive = String::from_utf8_lossy(&listing.stdout).contains(&child.to_string());
        assert!(!alive, "the job object ends processes the shell started");
    }
}
