//! Explicit opt-in probes. Every subprocess includes -S; no default server is ever contacted.
//! Run: cargo test -p tc-tmux --test native -- --ignored --nocapture --test-threads=1

use std::fs;
use std::path::PathBuf;
use std::process::Command as OsCommand;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use tc_tmux::parser::Notification;
use tc_tmux::{Client, ClientEvent, Command, Event, Options, PaneId, WindowId};

const TIMEOUT: Duration = Duration::from_secs(15);
static NEXT: AtomicU64 = AtomicU64::new(0);

struct Server {
    binary: PathBuf,
    profile: PathBuf,
    socket: PathBuf,
}

impl Server {
    fn new() -> Self {
        if !cfg!(unix) {
            panic!("Real tmux probes require native macOS/Linux.");
        }
        let binary =
            tc_tmux::client::find_binary(std::env::var_os("TC_TMUX_BINARY").as_deref().map(std::path::Path::new))
                .unwrap();
        let profile = std::env::temp_dir().join(format!(
            "tc-tmux-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&profile).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&profile, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let server = Self {
            socket: profile.join("s"),
            profile,
            binary,
        };
        // Ignore tmux user configuration and launch only a controlled local POSIX shell.
        server.run(&[
            "-f",
            "/dev/null",
            "new-session",
            "-d",
            "-s",
            "tc-spike",
            "-x",
            "80",
            "-y",
            "24",
            "/bin/sh",
        ]);
        server.run(&["set-option", "-g", "status", "off"]);
        server
    }

    fn run(&self, args: &[&str]) -> String {
        let output = OsCommand::new(&self.binary)
            .arg("-S")
            .arg(&self.socket)
            .args(args)
            .env_remove("TMUX")
            .env_remove("ENV")
            .env_remove("BASH_ENV")
            .env("HOME", &self.profile)
            .env("SHELL", "/bin/sh")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "tmux {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }

    fn client(&self) -> Client {
        let session = self
            .run(&["display-message", "-p", "-t", "tc-spike", "#{session_id}"])
            .trim()
            .parse()
            .unwrap();
        let client = Client::attach(Options {
            binary: Some(self.binary.clone()),
            socket: self.socket.clone(),
            session,
        })
        .unwrap();
        until(&client, |e| {
            matches!(
                e,
                ClientEvent::Protocol {
                    request: None,
                    event: Event::Reply { error: false, .. }
                }
            )
        });
        client
    }

    fn pane(&self) -> PaneId {
        self.run(&["display-message", "-p", "-t", "tc-spike", "#{pane_id}"])
            .trim()
            .parse()
            .unwrap()
    }

    fn window(&self) -> WindowId {
        self.run(&["display-message", "-p", "-t", "tc-spike", "#{window_id}"])
            .trim()
            .parse()
            .unwrap()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        // Only this test's explicitly named socket is stopped; cleanup never runs against defaults.
        let _ = OsCommand::new(&self.binary)
            .arg("-S")
            .arg(&self.socket)
            .arg("kill-server")
            .env_remove("TMUX")
            .output();
        let _ = fs::remove_dir_all(&self.profile);
    }
}

fn until(client: &Client, mut predicate: impl FnMut(&ClientEvent) -> bool) {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let event = client
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("tmux event deadline");
        if let ClientEvent::Disconnected(result) = &event {
            panic!("tmux disconnected: {result:?}");
        }
        if predicate(&event) {
            return;
        }
    }
}

fn reply(client: &mut Client, command: Command) -> Vec<Vec<u8>> {
    let id = client.submit(command).unwrap();
    let mut lines = None;
    until(client, |event| {
        if let ClientEvent::Protocol {
            request: Some(request),
            event: Event::Reply {
                error, lines: output, ..
            },
        } = event
            && *request == id
        {
            assert!(!error, "command {id} failed: {output:?}");
            lines = Some(output.clone());
            return true;
        }
        false
    });
    lines.unwrap()
}

fn send_output(client: &mut Client, pane: PaneId, script: &str, marker: &[u8]) -> Vec<u8> {
    // The marker must be assembled by the shell, so terminal echo cannot satisfy the wait.
    assert!(!script.as_bytes().windows(marker.len()).any(|w| w == marker));
    let request = client.submit(Command::send_keys(pane, script).unwrap()).unwrap();
    let mut output = Vec::new();
    let mut answered = false;
    until(client, |event| {
        match event {
            ClientEvent::Protocol {
                event: Event::Output { pane: id, bytes, .. },
                ..
            } if *id == pane => output.extend(bytes),
            ClientEvent::Protocol {
                request: Some(id),
                event: Event::Reply { error, lines, .. },
            } if *id == request => {
                assert!(!error, "send-keys failed: {lines:?}");
                answered = true;
            }
            _ => {}
        }
        answered && output.windows(marker.len()).any(|w| w == marker)
    });
    output
}

#[test]
#[ignore = "requires native tmux and creates only a disposable private server"]
fn pipe_protocol_osc_sizing_subscriptions_and_detach_survival() {
    let server = Server::new();
    let mut client = server.client();
    println!("tmux {:?}; private socket {}", client.version, server.socket.display());
    let pane = server.pane();
    let first = server.window();
    let pid = server.run(&["display-message", "-p", "-t", &pane.to_string(), "#{pane_pid}"]);
    reply(&mut client, Command::subscribe_cwd(pane));
    until(&client, |e| {
        matches!(
            e,
            ClientEvent::Protocol {
                event: Event::Notification {
                    kind: Notification::SubscriptionChanged,
                    ..
                },
                ..
            }
        )
    });

    // Real send-keys parsing must not interpret semicolons, braces or quotes as tmux commands.
    // A send-keys reply acknowledges delivery, not shell execution. Wait for shell-produced
    // evidence that echo is disabled before sending the payload; retain output on either side
    // of the reply. Neither marker occurs verbatim in input that the terminal could echo.
    send_output(
        &mut client,
        pane,
        "stty -echo && printf 'TC_ECHO_%s\\n' OFF\r",
        b"TC_ECHO_OFF",
    );
    let script = "printf '\\033]7;file:///tmp\\007\\033]777;tc-ready\\007\\360\\237\\230\\200\\n'; printf '%s\\n' \"; #{session_name} ' $HOME\"; printf 'TC_SPIKE_%s\\n' MARKER\r";
    let output = send_output(&mut client, pane, script, b"TC_SPIKE_MARKER");
    assert!(
        output
            .windows(b"\x1b]7;file:///tmp\x07\x1b]777;tc-ready\x07".len())
            .any(|w| w == b"\x1b]7;file:///tmp\x07\x1b]777;tc-ready\x07")
    );
    assert!(output.windows(4).any(|w| w == "😀".as_bytes()));

    let session = server
        .run(&["display-message", "-p", "-t", "tc-spike", "#{session_id}"])
        .trim()
        .parse()
        .unwrap();
    reply(
        &mut client,
        Command::new_window(session, &tc_tmux::Name::new("second").unwrap()),
    );
    let second: WindowId = server
        .run(&["display-message", "-p", "-t", "tc-spike:second", "#{window_id}"])
        .trim()
        .parse()
        .unwrap();
    reply(&mut client, Command::window_size(first, 91, 27).unwrap());
    reply(&mut client, Command::window_size(second, 103, 31).unwrap());
    assert_eq!(
        server
            .run(&[
                "display-message",
                "-p",
                "-t",
                &first.to_string(),
                "#{window_width}x#{window_height}"
            ])
            .trim(),
        "91x27"
    );
    assert_eq!(
        server
            .run(&[
                "display-message",
                "-p",
                "-t",
                &second.to_string(),
                "#{window_width}x#{window_height}"
            ])
            .trim(),
        "103x31"
    );
    reply(&mut client, Command::resize_window(first, 97, 29).unwrap());
    // tmux clamps even manual sizes to a control client's per-window advertisement.
    assert_eq!(
        server
            .run(&[
                "display-message",
                "-p",
                "-t",
                &first.to_string(),
                "#{window_width}x#{window_height}"
            ])
            .trim(),
        "91x27"
    );
    // Clearing only this window's cap exposes its requested manual size.
    reply(&mut client, Command::clear_window_size(first));
    assert_eq!(
        server
            .run(&[
                "display-message",
                "-p",
                "-t",
                &first.to_string(),
                "#{window_width}x#{window_height}"
            ])
            .trim(),
        "97x29"
    );
    assert_eq!(
        server
            .run(&[
                "display-message",
                "-p",
                "-t",
                &second.to_string(),
                "#{window_width}x#{window_height}"
            ])
            .trim(),
        "103x31"
    );
    drop(client);
    assert_eq!(
        server.run(&["display-message", "-p", "-t", &pane.to_string(), "#{pane_pid}"]),
        pid
    );
    let mut reattached = server.client();
    let history = reply(&mut reattached, Command::capture(pane, 5000)).join(&b'\n');
    assert!(
        history
            .windows(b"TC_SPIKE_MARKER".len())
            .any(|w| w == b"TC_SPIKE_MARKER")
    );
    // Explicit detach must also preserve the shell, not just dropping the transport.
    reattached.submit(Command::detach()).unwrap();
    until(&reattached, |e| {
        matches!(
            e,
            ClientEvent::Protocol {
                event: Event::Exit(_),
                ..
            }
        )
    });
    assert_eq!(
        server.run(&["display-message", "-p", "-t", &pane.to_string(), "#{pane_pid}"]),
        pid
    );
}

#[test]
#[ignore = "requires native tmux and creates only a disposable private server"]
fn flow_control_requires_capture_resync_after_pause() {
    let server = Server::new();
    let mut client = server.client();
    let pane = server.pane();
    reply(&mut client, Command::pause_after(1));
    let pause = client.submit(Command::pane_flow(pane, true)).unwrap();
    let mut paused = false;
    let mut answered = false;
    until(&client, |e| {
        match e {
            ClientEvent::Protocol {
                event:
                    Event::Notification {
                        kind: Notification::Pause,
                        ..
                    },
                ..
            } => paused = true,
            ClientEvent::Protocol {
                request: Some(id),
                event: Event::Reply {
                    error: false, lines, ..
                },
            } if *id == pause => {
                // tmux can emit synchronous %pause inside this command's reply block.
                // The parser preserves reply text verbatim instead of guessing it is async.
                paused |= lines.iter().any(|line| line == format!("%pause {pane}").as_bytes());
                answered = true;
            }
            _ => {}
        }
        paused && answered
    });
    // tmux discards paused protocol bytes, but retains the rendered screen/history. A phase 2
    // backend needs capture/resync; pause/continue cannot meet lossless byte-stream acceptance.
    reply(&mut client, Command::send_keys(pane, "i=0; while [ \"$i\" -lt 512 ]; do printf 'TC_BACKLOG_%04d\\n' \"$i\"; i=$((i+1)); done; printf 'TC_BACKLOG_DONE\\n'\r").unwrap());
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let history = reply(&mut client, Command::capture(pane, 2000)).join(&b'\n');
        if history
            .windows(b"TC_BACKLOG_0511".len())
            .any(|w| w == b"TC_BACKLOG_0511")
        {
            break;
        }
        assert!(Instant::now() < deadline, "paused pane did not produce history");
    }
    let request = client.submit(Command::pane_flow(pane, false)).unwrap();
    let mut answered = false;
    let mut continued = false;
    until(&client, |e| {
        match e {
            ClientEvent::Protocol {
                event:
                    Event::Notification {
                        kind: Notification::Continue,
                        ..
                    },
                ..
            } => continued = true,
            ClientEvent::Protocol {
                request: Some(id),
                event: Event::Reply {
                    error: false, lines, ..
                },
            } if *id == request => {
                continued |= lines.iter().any(|line| line == format!("%continue {pane}").as_bytes());
                answered = true;
            }
            _ => {}
        }
        continued && answered
    });
    let request = client
        .submit(Command::send_keys(pane, "printf 'TC_FLOW_MARKER\\n'\r").unwrap())
        .unwrap();
    let mut answered = false;
    let mut output: Vec<u8> = Vec::new();
    let mut extended = false;
    until(&client, |event| {
        match event {
            ClientEvent::Protocol {
                event: Event::Output { pane: id, age, bytes },
                ..
            } if *id == pane => {
                extended |= age.is_some();
                output.extend(bytes);
            }
            ClientEvent::Protocol {
                request: Some(id),
                event: Event::Reply { error: false, .. },
            } if *id == request => answered = true,
            _ => {}
        }
        answered && extended && output.windows(b"TC_FLOW_MARKER".len()).any(|w| w == b"TC_FLOW_MARKER")
    });
    let history = reply(&mut client, Command::capture(pane, 2000)).join(&b'\n');
    for i in 0..512 {
        let marker = format!("TC_BACKLOG_{i:04}");
        assert!(
            history.windows(marker.len()).any(|w| w == marker.as_bytes()),
            "missing {marker}"
        );
    }
    println!(
        "pause-after, pause/continue, extended output and capture resync accepted on {:?}; pause is lossy at the protocol level",
        client.version
    );
}
