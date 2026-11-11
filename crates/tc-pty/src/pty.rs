//! The real terminal backend, on portable-pty (ConPTY on Windows).
//!
//! Each terminal has three threads outside the host task: a reader, a writer (so a stalled shell
//! cannot block the host), and an exit waiter. Backpressure needs no `pause()` in the PTY: the
//! reader counts the output it sends, stops reading above [`HIGH_WATER`] unacknowledged UTF-16 units
//! until acknowledgments bring it below [`LOW_WATER`], the PTY buffer fills, and the program writing
//! to it blocks. Counting in the reader, not when the host handles the output, keeps a fast
//! program from getting far past the limit while the output is still queued for the host.

use std::io::{self, Read, Write};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tc_core::Platform;
use tc_core::node::Utf8Stream;

use crate::cwd::{DirectoryWatch, POLL_INTERVAL, process_directory};
use crate::manager::{
    Backend, EventSink, ExitStatus, HIGH_WATER, LOW_WATER, Process, SessionEvent, SessionKey, SpawnRequest,
};

/// How long an exited terminal's remaining output may take to arrive before the exit is reported.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const READ_BUFFER: usize = 64 * 1024;

fn other(error: impl std::fmt::Display) -> io::Error {
    io::Error::other(error.to_string())
}

/// Lets the host pause the reader thread.
#[derive(Default)]
struct Flow {
    state: Mutex<FlowState>,
    wake: Condvar,
}

#[derive(Default)]
struct FlowState {
    /// Output sent and not yet acknowledged, in UTF-16 units.
    pending: usize,
    paused: bool,
    /// The terminal ended: read everything that is left, whatever the UI has acknowledged.
    draining: bool,
    closed: bool,
}

impl Flow {
    fn update(&self, change: impl FnOnce(&mut FlowState)) {
        change(&mut self.state.lock().unwrap_or_else(|e| e.into_inner()));
        self.wake.notify_all();
    }

    /// Blocks while paused. Returns false once the terminal is gone.
    fn wait(&self) -> bool {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let state = self
            .wake
            .wait_while(state, |state| state.paused && !state.draining && !state.closed)
            .unwrap_or_else(|e| e.into_inner());
        !state.closed
    }
}

type SharedMaster = Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>;

/// Closes the PTY on another thread: closing a Windows pseudoconsole waits for its host process.
fn close_master(master: &SharedMaster) {
    if let Some(master) = master.lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = thread::Builder::new()
            .name("tc-pty-close".into())
            .spawn(move || drop(master));
    }
}

/// Keeps the child contained and the master alive until every worker has started. In particular,
/// dropping a Windows master before ending its child can block inside ClosePseudoConsole.
#[derive(Default)]
struct SpawnGuard {
    master: Option<SharedMaster>,
    flow: Option<Arc<Flow>>,
    killer: Option<Box<dyn ChildKiller + Send + Sync>>,
    #[cfg(windows)]
    job: Option<crate::job::Job>,
}

impl Drop for SpawnGuard {
    fn drop(&mut self) {
        if let Some(flow) = &self.flow {
            flow.update(|state| state.draining = true);
        }
        #[cfg(windows)]
        if let Some(job) = &self.job {
            job.terminate();
        }
        if let Some(killer) = &mut self.killer {
            let _ = killer.kill();
        }
        if let Some(master) = &self.master {
            close_master(master);
        }
    }
}

pub struct PtyBackend;

impl Backend for PtyBackend {
    fn spawn(&mut self, request: &SpawnRequest, key: SessionKey, events: EventSink) -> io::Result<Box<dyn Process>> {
        let size = PtySize {
            rows: request.rows,
            cols: request.cols,
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = native_pty_system().openpty(size).map_err(other)?;
        // Declared after `pair`, so failure kills the child before the raw pair can drop too.
        let mut startup = SpawnGuard::default();
        #[cfg(windows)]
        {
            startup.job = Some(crate::job::Job::new()?);
        }
        let mut command = CommandBuilder::new(&request.shell);
        command.args(&request.args);
        command.cwd(&request.cwd);
        #[cfg(windows)]
        command.set_windows_job(startup.job.as_ref().expect("job created").handle());
        command.env_clear();
        for (name, value) in &request.env {
            command.env(name, value);
        }
        let child = pair.slave.spawn_command(command).map_err(other)?;
        startup.killer = Some(child.clone_killer());
        drop(pair.slave);
        let pid = child.process_id();
        let reader = pair.master.try_clone_reader().map_err(other)?;
        let writer = pair.master.take_writer().map_err(other)?;
        let master: SharedMaster = Arc::new(Mutex::new(Some(pair.master)));
        startup.master = Some(Arc::clone(&master));
        let flow = Arc::new(Flow::default());
        startup.flow = Some(Arc::clone(&flow));
        let (input, inbox) = mpsc::channel();
        let (finished, drained) = mpsc::channel();
        let name = |role: &str| format!("tc-pty-{role}-{}", pid.unwrap_or_default());
        thread::Builder::new()
            .name(name("write"))
            .spawn(move || write_loop(writer, inbox))?;
        let (reader_flow, reader_key, reader_events) = (Arc::clone(&flow), key.clone(), Arc::clone(&events));
        thread::Builder::new()
            .name(name("read"))
            .spawn(move || read_loop(reader, &reader_flow, &reader_key, &reader_events, &finished))?;
        let (waiter_flow, waiter_master) = (Arc::clone(&flow), Arc::clone(&master));
        thread::Builder::new()
            .name(name("wait"))
            .spawn(move || wait_loop(child, &waiter_flow, &waiter_master, &drained, key, &events))?;
        let process = Box::new(PtyProcess {
            pid,
            input,
            master,
            killer: startup.killer.take().expect("child killer installed"),
            flow,
            #[cfg(windows)]
            job: startup.job.take().expect("job created"),
        });
        // Ownership now belongs to the process; successful startup must not trigger cleanup.
        startup.master = None;
        startup.flow = None;
        Ok(process)
    }

    fn watch_directory(&mut self, pid: u32, platform: Platform, key: SessionKey, events: EventSink) -> Box<dyn Send> {
        Box::new(DirectoryWatch::start(
            pid,
            platform,
            POLL_INTERVAL,
            process_directory,
            move |cwd| {
                events(key.clone(), SessionEvent::Directory(cwd));
            },
        ))
    }
}

fn write_loop(mut writer: Box<dyn Write + Send>, inbox: Receiver<String>) {
    for data in inbox {
        if writer.write_all(data.as_bytes()).and_then(|()| writer.flush()).is_err() {
            break;
        }
    }
}

fn read_loop(
    mut reader: Box<dyn Read + Send>,
    flow: &Flow,
    key: &SessionKey,
    events: &EventSink,
    finished: &Sender<()>,
) {
    let mut buffer = vec![0; READ_BUFFER];
    let mut decoder = Utf8Stream::new();
    while flow.wait() {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                let text = decoder.decode(&buffer[..read]);
                if !text.is_empty() {
                    // Count before sending, so an acknowledgment can never arrive first.
                    let units = tc_core::js::utf16_len(&text);
                    flow.update(|state| {
                        state.pending += units;
                        if state.pending > HIGH_WATER {
                            state.paused = true;
                        }
                    });
                    events(key.clone(), SessionEvent::Output(text));
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
    let rest = decoder.finish();
    if !rest.is_empty() {
        events(key.clone(), SessionEvent::Output(rest));
    }
    let _ = finished.send(());
}

fn wait_loop(
    child: Box<dyn Child + Send + Sync>,
    flow: &Flow,
    master: &SharedMaster,
    drained: &Receiver<()>,
    key: SessionKey,
    events: &EventSink,
) {
    let status = wait(child);
    flow.update(|state| state.draining = true);
    // A pseudoconsole keeps its output pipe open until it is closed.
    if cfg!(windows) {
        close_master(master);
    }
    let _ = drained.recv_timeout(DRAIN_TIMEOUT);
    events(key, SessionEvent::Exit(status));
}

/// The exit code and signal, as node-pty reported them: a shell ended by a signal has code 0.
fn wait(child: Box<dyn Child + Send + Sync>) -> ExitStatus {
    #[cfg(unix)]
    let child = {
        use std::os::unix::process::ExitStatusExt;
        let child: Box<dyn Child> = child;
        match child.downcast::<std::process::Child>() {
            Ok(mut child) => {
                return match child.wait() {
                    Ok(status) => ExitStatus {
                        code: status.code().map_or(0, i64::from),
                        signal: status.signal(),
                    },
                    Err(_) => ExitStatus { code: 1, signal: None },
                };
            }
            Err(child) => child,
        }
    };
    let mut child = child;
    match child.wait() {
        Ok(status) => ExitStatus {
            code: i64::from(status.exit_code()),
            signal: None,
        },
        Err(_) => ExitStatus { code: 1, signal: None },
    }
}

struct PtyProcess {
    pid: Option<u32>,
    input: Sender<String>,
    master: SharedMaster,
    #[cfg_attr(unix, allow(dead_code))]
    killer: Box<dyn ChildKiller + Send + Sync>,
    flow: Arc<Flow>,
    #[cfg(windows)]
    job: crate::job::Job,
}

impl Process for PtyProcess {
    fn pid(&self) -> Option<u32> {
        self.pid
    }

    fn write(&mut self, data: &str) -> io::Result<()> {
        self.input
            .send(data.to_owned())
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "The terminal is no longer accepting input."))
    }

    fn resize(&mut self, cols: u16, rows: u16) -> io::Result<()> {
        match self.master.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            Some(master) => master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(other),
            None => Ok(()),
        }
    }

    // The reader applies the same watermarks itself; see the module documentation.
    fn pause(&mut self) {}

    fn resume(&mut self) {}

    fn acknowledge(&mut self, units: usize) {
        self.flow.update(|state| {
            state.pending = state.pending.saturating_sub(units);
            if state.pending < LOW_WATER {
                state.paused = false;
            }
        });
    }

    fn kill(&mut self) {
        self.flow.update(|state| state.draining = true);
        #[cfg(unix)]
        {
            use rustix::process::{Pid, Signal, kill_process_group};
            // The shell leads its own session. Hang up its process group and the foreground job,
            // which interactive shells run in a group of its own.
            let foreground = self
                .master
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_ref()
                .and_then(|m| m.process_group_leader());
            let groups = foreground
                .into_iter()
                .chain(self.pid.and_then(|pid| i32::try_from(pid).ok()));
            for group in groups.filter_map(Pid::from_raw) {
                let _ = kill_process_group(group, Signal::HUP);
            }
        }
        #[cfg(windows)]
        {
            self.job.terminate();
            let _ = self.killer.kill();
        }
        // Closing the PTY hangs up anything still attached to it.
        close_master(&self.master);
    }
}

impl Drop for PtyProcess {
    fn drop(&mut self) {
        self.flow.update(|state| state.closed = true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    struct Killer(Sender<&'static str>);
    impl ChildKiller for Killer {
        fn kill(&mut self) -> io::Result<()> {
            let _ = self.0.send("kill");
            Ok(())
        }
        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(Killer(self.0.clone()))
        }
    }
    struct Master(Sender<&'static str>);
    impl MasterPty for Master {
        fn resize(&self, _: PtySize) -> anyhow::Result<()> {
            Ok(())
        }
        fn get_size(&self) -> anyhow::Result<PtySize> {
            Ok(PtySize::default())
        }
        fn try_clone_reader(&self) -> anyhow::Result<Box<dyn Read + Send>> {
            Ok(Box::new(io::empty()))
        }
        fn take_writer(&self) -> anyhow::Result<Box<dyn Write + Send>> {
            Ok(Box::new(io::sink()))
        }
        #[cfg(unix)]
        fn process_group_leader(&self) -> Option<i32> {
            None
        }
        #[cfg(unix)]
        fn as_raw_fd(&self) -> Option<i32> {
            None
        }
        #[cfg(unix)]
        fn tty_name(&self) -> Option<std::path::PathBuf> {
            None
        }
    }
    impl Drop for Master {
        fn drop(&mut self) {
            let _ = self.0.send("master");
        }
    }

    #[test]
    fn failed_worker_start_ends_the_child_before_closing_the_master_and_unblocks_the_reader() {
        let (events, received) = mpsc::channel();
        let master: SharedMaster = Arc::new(Mutex::new(Some(Box::new(Master(events.clone())))));
        let flow = Arc::new(Flow::default());
        flow.update(|state| {
            state.pending = HIGH_WATER + 1;
            state.paused = true;
        });
        let startup = SpawnGuard {
            master: Some(Arc::clone(&master)),
            flow: Some(Arc::clone(&flow)),
            killer: Some(Box::new(Killer(events))),
            #[cfg(windows)]
            job: None,
        };
        // Other locals disappear while unwinding startup; the guard keeps the master alive.
        drop(master);
        drop(startup);
        assert_eq!(received.recv_timeout(Duration::from_secs(2)).unwrap(), "kill");
        assert_eq!(received.recv_timeout(Duration::from_secs(2)).unwrap(), "master");
        assert!(flow.state.lock().unwrap().draining);
    }
}
