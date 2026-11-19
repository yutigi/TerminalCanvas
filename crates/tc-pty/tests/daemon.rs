//! The terminal helper keeps a real shell running between attachments, replays its output, and
//! cleans up after it (see `tc_pty::daemon`).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use tc_pty::daemon::{Attachment, Daemon, serve_until_idle};
use tc_pty::integration::Integration;
use tc_pty::manager::{EventSink, ExitStatus, SessionEvent, SessionKey, SpawnRequest};

struct View {
    attachment: Attachment,
    events: Receiver<SessionEvent>,
    output: String,
}

fn sink() -> (EventSink, Receiver<SessionEvent>) {
    let (sender, events) = mpsc::channel();
    let sink: EventSink = Arc::new(move |_key: SessionKey, event| {
        let _ = sender.send(event);
    });
    (sink, events)
}

fn key(generation: u64) -> SessionKey {
    SessionKey {
        id: "card".into(),
        generation,
    }
}

impl View {
    /// Reads output, answering ConPTY's cursor query as a terminal would, until `done` or an exit.
    fn until(&mut self, what: &str, done: impl Fn(&str) -> bool) -> Option<ExitStatus> {
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            match self.events.recv_timeout(Duration::from_millis(50)) {
                Ok(SessionEvent::Output(data)) => {
                    self.attachment.process.acknowledge(data.encode_utf16().count());
                    if data.contains("\x1b[6n") {
                        self.attachment.process.write("\x1b[1;1R").unwrap();
                    }
                    self.output.push_str(&data);
                    if done(&self.output) {
                        return None;
                    }
                }
                Ok(SessionEvent::Exit(status)) => return Some(status),
                _ => {}
            }
        }
        panic!("timed out waiting for {what}; output: {:?}", self.output);
    }

    fn exit(&mut self) -> ExitStatus {
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            if let Ok(SessionEvent::Exit(status)) = self.events.recv_timeout(Duration::from_millis(50)) {
                return status;
            }
        }
        panic!("the view did not end");
    }
}

/// Types a line that prints the sum of two numbers, so the result differs from the input.
type Sum = fn(u32, u32) -> String;

/// A shell, its arguments, and how to ask it for a sum.
fn shell() -> (String, Vec<String>, Sum) {
    if cfg!(windows) {
        ("cmd.exe".into(), vec!["/d".into()], |a, b| format!("set /a {a}+{b}\r"))
    } else {
        ("/bin/sh".into(), Vec::new(), |a, b| format!("echo $(({a}+{b}))\r"))
    }
}

#[test]
fn a_kept_terminal_survives_detaching_replays_its_output_and_cleans_up_when_it_ends() {
    let folder = std::env::temp_dir().join(format!("tc-daemon-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&folder).unwrap();
    let daemon = Daemon::new(PathBuf::from("unused"), folder.clone());
    let state = daemon.state_file();
    let server = std::thread::spawn(move || serve_until_idle(&state, Duration::from_secs(2)));
    let deadline = Instant::now() + Duration::from_secs(10);
    while !daemon.state_file().is_file() {
        assert!(Instant::now() < deadline, "the helper did not start");
        std::thread::sleep(Duration::from_millis(20));
    }

    // The helper removes a terminal's integration files when it ends unattached.
    let session_file = folder.join("session.json");
    std::fs::write(&session_file, "{}").unwrap();
    let integration = Integration::new(None, None, session_file.clone(), Vec::new());
    let (program, args, sum) = shell();
    let request = SpawnRequest {
        shell: program.clone(),
        args,
        cwd: folder.to_string_lossy().into_owned(),
        cols: 80,
        rows: 24,
        env: std::env::vars().collect::<BTreeMap<_, _>>(),
    };
    let (events, receiver) = sink();
    let mut view = View {
        attachment: daemon
            .create("card", &request, Some(&integration), key(1), events)
            .unwrap(),
        events: receiver,
        output: String::new(),
    };
    assert_eq!(view.attachment.shell, program);
    assert!(view.attachment.process.pid().is_some());
    view.attachment.process.write(&sum(1300, 37)).unwrap();
    assert_eq!(view.until("the first sum", |output| output.contains("1337")), None);

    // Detaching ends the view without an error and leaves the shell running.
    view.attachment.process.kill();
    assert_eq!(view.exit(), ExitStatus { code: 0, signal: None });
    let kept = daemon.terminals();
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].id, "card");
    assert_eq!(
        kept[0].integration.as_ref().map(|kept| kept.session_file.clone()),
        Some(session_file.clone())
    );

    // Attaching again starts from a reset with the earlier output, and the shell still answers.
    let (events, receiver) = sink();
    let mut view = View {
        attachment: daemon.attach("card", 100, 30, key(2), events).unwrap(),
        events: receiver,
        output: String::new(),
    };
    assert_eq!(view.until("the replay", |output| output.contains("1337")), None);
    assert!(view.output.starts_with("\x1bc"), "{:?}", view.output);
    assert!(!view.output.contains("\x1b[6n"), "queries are not replayed");
    view.attachment.process.write(&sum(2000, 24)).unwrap();
    assert_eq!(view.until("the second sum", |output| output.contains("2024")), None);

    // A second view takes over from the first.
    let (events, receiver) = sink();
    let mut second = View {
        attachment: daemon.attach("card", 100, 30, key(3), events).unwrap(),
        events: receiver,
        output: String::new(),
    };
    assert_eq!(
        second.until("the second replay", |output| output.contains("2024")),
        None
    );
    view.exit();
    second.attachment.process.kill();
    second.exit();

    // Ending it while nothing is attached removes its files, and the idle helper exits.
    daemon.kill("card");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !daemon.terminals().is_empty() {
        assert!(Instant::now() < deadline, "the terminal did not end");
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!session_file.exists());
    assert!(daemon.attach("card", 80, 24, key(4), sink().0).is_err());
    server.join().unwrap().unwrap();
    assert!(!daemon.state_file().exists());
    std::fs::remove_dir_all(folder).unwrap();
}

#[test]
fn a_helper_that_cannot_prove_the_secret_is_refused() {
    use std::net::TcpListener;
    let folder = std::env::temp_dir().join(format!("tc-daemon-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&folder).unwrap();
    // Something else listens where the state file points, and answers with a made-up proof.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let daemon = Daemon::new(PathBuf::from("unused"), folder.clone());
    std::fs::write(
        daemon.state_file(),
        format!(
            r#"{{"protocol":1,"port":{port},"pid":1,"secret":"{}"}}"#,
            "0".repeat(64)
        ),
    )
    .unwrap();
    let impostor = std::thread::spawn(move || {
        use std::io::{BufRead, BufReader, Write};
        let (mut stream, _) = listener.accept().unwrap();
        let mut hello = String::new();
        BufReader::new(stream.try_clone().unwrap())
            .read_line(&mut hello)
            .unwrap();
        let reply = format!(
            r#"{{"protocol":1,"proof":"{}","nonce":"{}"}}"#,
            "f".repeat(64),
            "a".repeat(64)
        );
        stream.write_all(format!("{reply}\n").as_bytes()).unwrap();
        // The client must hang up instead of sending its proof or a request.
        let mut rest = String::new();
        BufReader::new(stream).read_line(&mut rest).unwrap_or_default();
        rest
    });
    assert!(daemon.terminals().is_empty());
    assert_eq!(impostor.join().unwrap(), "");
    std::fs::remove_dir_all(folder).unwrap();
}
