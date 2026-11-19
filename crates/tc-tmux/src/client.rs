//! Pipe control client. Dropping it terminates only the attached client, never the tmux server.
//!
//! Host adapters should associate this connection's events with their own SessionKey generation.
//! Commands have local request IDs; tmux reply numbers are server command-queue IDs, not our IDs.

use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command as OsCommand, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crate::{Command, Event, Parser, SessionId};

const QUEUE_COMMANDS: usize = 16;
const QUEUE_EVENTS: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version {
    pub major: u32,
    pub minor: u32,
}

impl Version {
    /// Per-window `refresh-client -C @window:WxH` first appears in tmux 3.3.
    /// CI probes 3.3a and the runner's current release; local Windows builds cannot verify it.
    pub const MINIMUM: Self = Self { major: 3, minor: 3 };

    pub fn parse(text: &str) -> io::Result<Self> {
        let text = text
            .trim()
            .strip_prefix("tmux ")
            .ok_or_else(|| invalid("Unrecognized tmux version."))?;
        let (major, minor) = text
            .split_once('.')
            .ok_or_else(|| invalid("Unrecognized tmux version."))?;
        let digits = minor.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 || !minor[digits..].bytes().all(|b| b.is_ascii_alphabetic()) {
            return Err(invalid("Unrecognized tmux version."));
        }
        Ok(Self {
            major: major.parse().map_err(|_| invalid("Unrecognized tmux version."))?,
            minor: minor[..digits]
                .parse()
                .map_err(|_| invalid("Unrecognized tmux version."))?,
        })
    }

    pub fn probe(binary: &Path) -> io::Result<Self> {
        let output = OsCommand::new(binary).arg("-V").output()?;
        if !output.status.success() {
            return Err(io::Error::other("tmux -V failed."));
        }
        let version = Self::parse(&String::from_utf8_lossy(&output.stdout))?;
        if version < Self::MINIMUM {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "tmux 3.3 or newer is required for per-window control-client sizing.",
            ));
        }
        Ok(version)
    }
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

pub fn find_binary(configured: Option<&Path>) -> io::Result<PathBuf> {
    if let Some(path) = configured {
        if path.is_file() {
            return Ok(path.to_owned());
        }
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "Configured tmux binary was not found.",
        ));
    }
    let mut directories: Vec<_> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    directories.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
    ]);
    directories
        .into_iter()
        .map(|p| p.join("tmux"))
        .find(|p| p.is_file())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "tmux was not found. Install native tmux 3.3+ or configure its binary path.",
            )
        })
}

/// Experimental MSYS2/Cygwin transport. A control client normally hands its stdin/stdout to the
/// server over the socket, but Cygwin's emulated AF_UNIX cannot pass descriptors, so a piped
/// client is never served. Cygwin tmux instead reopens a client's terminal by name, so the client
/// runs on a Cygwin pty made by `script`, in raw mode so protocol bytes pass unchanged.
fn cygwin_control_command(binary: &Path, options: &Options) -> io::Result<OsCommand> {
    let tools = binary
        .parent()
        .ok_or_else(|| invalid("The tmux binary has no parent folder."))?;
    let script = tools.join("script.exe");
    if !script.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "The MSYS2/Cygwin `script` tool must sit next to tmux (pacman -S util-linux).",
        ));
    }
    let mut path = vec![tools.to_owned()];
    path.extend(
        std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
            .unwrap_or_default(),
    );
    let mut command = OsCommand::new(script);
    // Values travel only through the environment. With globbing and field splitting disabled the
    // shell never reinterprets them, so the command line itself needs no quoting.
    command
        .args([
            "-qfec",
            "set -f; IFS=; stty raw -echo; exec $TC_TMUX -S $TC_SOCKET -f /dev/null -C attach-session -t $TC_SESSION",
            "/dev/null",
        ])
        .env(
            "PATH",
            std::env::join_paths(path).map_err(|_| invalid("PATH is not representable."))?,
        )
        // Cygwin programs glob/brace-expand a native caller's command line ("#{x}" -> "#x").
        .env("MSYS", "noglob")
        .env("CYGWIN", "noglob")
        .env("TC_TMUX", binary)
        .env("TC_SOCKET", &options.socket)
        .env("TC_SESSION", options.session.to_string());
    Ok(command)
}

/// Phase 1 always requires an explicit socket, even outside tests. There is no default-server
/// fallback. Phase 2 can add a separately validated production connection policy.
pub struct Options {
    pub binary: Option<PathBuf>,
    pub socket: PathBuf,
    pub session: SessionId,
}

#[derive(Debug)]
pub enum ClientEvent {
    /// `request` is None for the initial attach reply, Some(local ID) for submitted commands.
    Protocol {
        request: Option<u64>,
        event: Event,
    },
    Disconnected(Result<(), String>),
}

struct Request {
    id: u64,
    command: Command,
}

pub struct Client {
    child: Child,
    input: Option<SyncSender<Request>>,
    events: Option<Receiver<ClientEvent>>,
    workers: Vec<JoinHandle<()>>,
    next_id: u64,
    pub version: Version,
}

impl Client {
    pub fn attach(options: Options) -> io::Result<Self> {
        // Windows has no native tmux. An explicitly configured MSYS2/Cygwin build is an
        // experimental opt-in; there is no automatic discovery there.
        if !cfg!(unix) && options.binary.is_none() {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "On Windows, configure an MSYS2/Cygwin tmux binary path; WSL integration is a later phase.",
            ));
        }
        if !options.socket.is_absolute() {
            return Err(invalid("An absolute private tmux socket path is required."));
        }
        let binary = find_binary(options.binary.as_deref())?;
        let version = Version::probe(&binary)?;
        // -C is the pipe protocol. -CC includes terminal-emulator DCS framing and terminal modes.
        // Ignore user config when starting a server (normally attach requires an existing one).
        let mut command = if cfg!(windows) {
            cygwin_control_command(&binary, &options)?
        } else {
            let mut command = OsCommand::new(binary);
            command.args([
                "-S".as_ref(),
                options.socket.as_os_str(),
                "-f".as_ref(),
                "/dev/null".as_ref(),
                "-C".as_ref(),
                "attach-session".as_ref(),
                "-t".as_ref(),
                options.session.to_string().as_ref(),
            ]);
            command
        };
        let mut child = command
            .env_remove("TMUX")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // No inherited terminal and no unread stderr pipe that can deadlock a child.
            .stderr(Stdio::null())
            .spawn()?;
        let input = child.stdin.take().expect("piped stdin");
        let output = child.stdout.take().expect("piped stdout");
        let (requests, inbox) = mpsc::sync_channel(QUEUE_COMMANDS);
        let (pending, replies) = mpsc::sync_channel(QUEUE_COMMANDS);
        let (events, received) = mpsc::sync_channel(QUEUE_EVENTS);
        let reader = match thread::Builder::new()
            .name("tc-tmux-read".into())
            .spawn(move || read_loop(output, replies, events))
        {
            Ok(worker) => worker,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let writer = match thread::Builder::new()
            .name("tc-tmux-write".into())
            .spawn(move || write_loop(input, inbox, pending))
        {
            Ok(worker) => worker,
            Err(error) => {
                drop(received);
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err(error);
            }
        };
        Ok(Self {
            child,
            input: Some(requests),
            events: Some(received),
            workers: vec![reader, writer],
            next_id: 1,
            version,
        })
    }

    /// Never blocks the host actor. A full queue returns WouldBlock; callers must retry in order.
    pub fn submit(&mut self, command: Command) -> io::Result<u64> {
        let id = self.next_id;
        let next = id
            .checked_add(1)
            .ok_or_else(|| io::Error::other("tmux request ID exhausted."))?;
        self.input
            .as_ref()
            .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "tmux client is closed."))?
            .try_send(Request { id, command })
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => io::Error::new(io::ErrorKind::WouldBlock, "tmux command queue is full."),
                mpsc::TrySendError::Disconnected(_) => {
                    io::Error::new(io::ErrorKind::BrokenPipe, "tmux client is closed.")
                }
            })?;
        self.next_id = next;
        Ok(id)
    }

    pub fn recv_timeout(&self, timeout: Duration) -> Result<ClientEvent, RecvTimeoutError> {
        self.events.as_ref().expect("live client").recv_timeout(timeout)
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        // Release a reader blocked on the bounded event queue before joining either worker.
        self.events.take();
        self.input.take();
        // Only this control client is killed. No kill-window/session/server commands exist here.
        let _ = self.child.kill();
        let _ = self.child.wait();
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
    }
}

fn write_loop(mut input: impl Write, inbox: Receiver<Request>, pending: SyncSender<u64>) {
    for request in inbox {
        if pending.send(request.id).is_err()
            || input
                .write_all(request.command.as_str().as_bytes())
                .and_then(|()| input.write_all(b"\n"))
                .and_then(|()| input.flush())
                .is_err()
        {
            break;
        }
    }
    // EOF detaches tmux's control client when its owner closes the command queue.
}

fn read_loop(mut output: impl Read, pending: Receiver<u64>, events: SyncSender<ClientEvent>) {
    let mut parser = Parser::new();
    let mut buffer = [0; 8192];
    let mut exited = false;
    let result: Result<(), String> = (|| {
        loop {
            let count = match output.read(&mut buffer) {
                Ok(count) => count,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error.to_string()),
            };
            if count == 0 {
                parser.finish().map_err(|e| e.to_string())?;
                return if exited {
                    Ok(())
                } else {
                    Err("tmux closed without an exit notification; check that the socket and session exist.".into())
                };
            }
            for event in parser.feed(&buffer[..count]).map_err(|e| e.to_string())? {
                exited |= matches!(event, Event::Exit(_));
                let request = match &event {
                    Event::Reply { id, .. } if id.flags & 1 != 0 => Some(
                        pending
                            .try_recv()
                            .map_err(|_| "tmux replied without a pending command.".to_owned())?,
                    ),
                    _ => None,
                };
                if events.send(ClientEvent::Protocol { request, event }).is_err() {
                    return Ok(());
                }
            }
        }
    })();
    let _ = events.send(ClientEvent::Disconnected(result));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_floor_and_suffixes() {
        for value in ["tmux 3.3", "tmux 3.3a\n", "tmux 3.6", "tmux 4.0"] {
            assert!(Version::parse(value).unwrap() >= Version::MINIMUM);
        }
        assert!(Version::parse("tmux 3.1c").unwrap() < Version::MINIMUM);
        assert!(Version::parse("tmux 3.2a").unwrap() < Version::MINIMUM);
        for value in ["3.2", "tmux next-3.7", "tmux 3.", "tmux 3.2;bad", "tmux 3.2\nextra"] {
            assert!(Version::parse(value).is_err());
        }
    }

    #[test]
    fn startup_reply_is_not_assigned_to_first_command() {
        let (pending, replies) = mpsc::sync_channel(2);
        pending.send(42).unwrap();
        pending.send(43).unwrap();
        let (events, received) = mpsc::sync_channel(5);
        read_loop(
            b"%begin 1 90 0\n%end 1 90 0\n%begin 1 91 1\none\n%end 1 91 1\n%begin 1 93 1\nbad command\n%error 1 93 1\n%exit\n"
                .as_slice(),
            replies,
            events,
        );
        let items: Vec<_> = received.try_iter().collect();
        assert!(matches!(items[0], ClientEvent::Protocol { request: None, .. }));
        assert!(matches!(items[1], ClientEvent::Protocol { request: Some(42), .. }));
        assert!(matches!(
            items[2],
            ClientEvent::Protocol {
                request: Some(43),
                event: Event::Reply { error: true, .. }
            }
        ));
        assert!(matches!(
            items[3],
            ClientEvent::Protocol {
                event: Event::Exit(_),
                ..
            }
        ));
        assert!(matches!(items[4], ClientEvent::Disconnected(Ok(()))));
    }

    #[test]
    fn malformed_eof_and_unsolicited_command_reply_disconnect() {
        for wire in [
            b"".as_slice(),
            b"%output %1 \\x\n",
            b"%begin 1 2 1\n",
            b"%begin 1 2 1\n%end 1 2 1\n",
        ] {
            let (_pending, replies) = mpsc::sync_channel(1);
            let (events, received) = mpsc::sync_channel(1);
            read_loop(wire, replies, events);
            assert!(
                matches!(received.recv().unwrap(), ClientEvent::Disconnected(Err(_))),
                "{wire:?}"
            );
        }
    }

    #[test]
    fn dropping_consumer_releases_reader_blocked_by_event_limit() {
        let (_pending, replies) = mpsc::sync_channel(1);
        let (events, received) = mpsc::sync_channel(1);
        let (finished, completion) = mpsc::channel();
        let worker = thread::spawn(move || {
            read_loop(
                b"%sessions-changed\n%sessions-changed\n%exit\n".as_slice(),
                replies,
                events,
            );
            finished.send(()).unwrap();
        });
        assert!(matches!(
            received.recv_timeout(Duration::from_secs(2)).unwrap(),
            ClientEvent::Protocol { .. }
        ));
        drop(received);
        completion
            .recv_timeout(Duration::from_secs(2))
            .expect("blocked reader did not release");
        worker.join().unwrap();
    }

    #[test]
    fn writer_registers_request_before_writing_exactly_one_line() {
        let (requests, inbox) = mpsc::sync_channel(1);
        let (pending, replies) = mpsc::sync_channel(1);
        requests
            .send(Request {
                id: 7,
                command: Command::send_keys("%1".parse().unwrap(), "a\nb").unwrap(),
            })
            .unwrap();
        drop(requests);
        let mut bytes = Vec::new();
        write_loop(&mut bytes, inbox, pending);
        assert_eq!(replies.recv().unwrap(), 7);
        assert_eq!(bytes, b"send-keys -t '%1' -H 61 0a 62\n");
    }
}
