//! A shell process's current directory on macOS and Linux, from `processDirectory` and
//! `watchDirectory` in `src/terminal-cwd.cjs`.
//!
//! Linux reads `/proc/<pid>/cwd`. macOS keeps running `/usr/sbin/lsof`, as the JavaScript host did;
//! switching to `libproc` would change which directories are visible, so it is not done here.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tc_core::Platform;
use tc_core::osc::valid_directory;

const LSOF_TIMEOUT: Duration = Duration::from_millis(800);
const LSOF_MAX_OUTPUT: usize = 65536;
/// How long the watcher waits after each lookup.
pub const POLL_INTERVAL: Duration = Duration::from_millis(1000);

/// The current directory of `pid`, or `None` when it is unknown: missing permissions, an exited
/// process, an unavailable tool, or an unsupported platform.
pub fn process_directory(pid: u32, platform: Platform) -> Option<String> {
    if pid == 0 {
        return None;
    }
    let directory = match platform {
        Platform::Linux => std::fs::read_link(format!("/proc/{pid}/cwd"))
            .ok()?
            .into_os_string()
            .into_string()
            .ok()?,
        Platform::MacOs => {
            let stdout = run_with_timeout(
                "/usr/sbin/lsof",
                &["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn0"],
                LSOF_TIMEOUT,
            )?;
            lsof_name(&stdout)?.to_owned()
        }
        _ => return None,
    };
    valid_directory(&directory, platform)
}

/// The name field of `lsof -Fn0` output: NUL-terminated fields, the name one starting with `n`.
pub fn lsof_name(stdout: &str) -> Option<&str> {
    let field = stdout
        .split('\0')
        .find(|field| field.strip_prefix('\n').unwrap_or(field).starts_with('n'))?;
    let field = field.strip_prefix('\n').unwrap_or(field);
    field.strip_prefix('n')
}

/// Runs a program and returns its output, or `None` if it fails, prints more than 64 KB, or runs
/// longer than `timeout`.
fn run_with_timeout(program: &str, args: &[&str], timeout: Duration) -> Option<String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = thread::spawn(move || {
        let mut output = Vec::new();
        let limited = (&mut stdout).take(LSOF_MAX_OUTPUT as u64 + 1).read_to_end(&mut output);
        limited.ok().map(|_| output)
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    let output = reader.join().ok()??;
    if !status.success() || output.len() > LSOF_MAX_OUTPUT {
        return None;
    }
    Some(String::from_utf8_lossy(&output).into_owned())
}

/// Polls a process's directory until dropped or disposed. Lookups never overlap, and a result that
/// arrives after disposal is discarded.
pub struct DirectoryWatch {
    state: Arc<(Mutex<bool>, Condvar)>,
    disposed: Arc<AtomicBool>,
}

impl DirectoryWatch {
    /// Looks up `pid`'s directory now and again `interval` after each lookup finishes, passing each
    /// result to `report`.
    pub fn start<R, F>(pid: u32, platform: Platform, interval: Duration, read: R, report: F) -> Self
    where
        R: Fn(u32, Platform) -> Option<String> + Send + 'static,
        F: Fn(Option<String>) + Send + 'static,
    {
        let state = Arc::new((Mutex::new(false), Condvar::new()));
        let disposed = Arc::new(AtomicBool::new(false));
        let (thread_state, thread_disposed) = (Arc::clone(&state), Arc::clone(&disposed));
        thread::Builder::new()
            .name(format!("tc-cwd-{pid}"))
            .spawn(move || {
                loop {
                    let cwd = read(pid, platform).and_then(|cwd| valid_directory(&cwd, platform));
                    if thread_disposed.load(Ordering::SeqCst) {
                        return;
                    }
                    report(cwd);
                    let (lock, wake) = &*thread_state;
                    let stopped = lock.lock().unwrap_or_else(|e| e.into_inner());
                    let (stopped, _) = wake
                        .wait_timeout_while(stopped, interval, |stopped| !*stopped)
                        .unwrap_or_else(|e| e.into_inner());
                    if *stopped {
                        return;
                    }
                }
            })
            .expect("the directory watcher thread starts");
        DirectoryWatch { state, disposed }
    }

    pub fn dispose(&self) {
        self.disposed.store(true, Ordering::SeqCst);
        let (lock, wake) = &*self.state;
        *lock.lock().unwrap_or_else(|e| e.into_inner()) = true;
        wake.notify_all();
    }
}

impl Drop for DirectoryWatch {
    fn drop(&mut self) {
        self.dispose();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn lsof_names_are_nul_delimited() {
        assert_eq!(
            lsof_name("p124\0\nfcwd\0n/Users/name/a folder/子\0\n"),
            Some("/Users/name/a folder/子")
        );
        assert_eq!(lsof_name("p124\0\n"), None);
    }

    #[test]
    fn unknown_processes_and_platforms_have_no_directory() {
        assert_eq!(process_directory(0, Platform::Linux), None);
        assert_eq!(process_directory(42, Platform::Other), None);
        assert_eq!(process_directory(2_147_483_647, Platform::current()), None);
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn finds_this_process_directory() {
        let expected = std::env::current_dir().unwrap().canonicalize().unwrap();
        let found = process_directory(std::process::id(), Platform::current()).expect("a directory");
        assert_eq!(std::path::Path::new(&found).canonicalize().unwrap(), expected);
    }

    #[test]
    fn polling_reports_until_disposed_and_drops_late_results() {
        let (reports, received) = mpsc::channel();
        let calls = Arc::new(Mutex::new(0));
        let counter = Arc::clone(&calls);
        let watch = DirectoryWatch::start(
            42,
            Platform::Linux,
            Duration::from_millis(20),
            move |_, _| {
                let mut calls = counter.lock().unwrap();
                *calls += 1;
                [Some("/first path".to_owned()), None, Some("relative".to_owned())][(*calls - 1) % 3].clone()
            },
            move |cwd| reports.send(cwd).unwrap(),
        );
        let first: Vec<_> = (0..3)
            .map(|_| received.recv_timeout(Duration::from_secs(2)).unwrap())
            .collect();
        assert_eq!(first, [Some("/first path".to_owned()), None, None]);
        watch.dispose();
        thread::sleep(Duration::from_millis(60));
        while received.try_recv().is_ok() {}
        let calls_after = *calls.lock().unwrap();
        thread::sleep(Duration::from_millis(60));
        assert_eq!(*calls.lock().unwrap(), calls_after, "no lookups after disposal");
        assert!(received.try_recv().is_err());
    }
}
