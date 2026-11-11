//! Windows Job Objects. A shell joins its job in CreateProcessW, before startup code can create
//! children. Stop terminates the job; closing its last handle after a host crash kills the tree.
#![allow(unsafe_code)]

use std::ffi::c_void;
use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::sync::Arc;

use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
};

pub struct Job(Arc<OwnedHandle>);

impl Job {
    /// Creates a job before the child is spawned. Failure prevents starting a terminal without
    /// process-tree cleanup; it is never silently downgraded to killing only the shell.
    pub fn new() -> io::Result<Job> {
        // SAFETY: null attributes and name create an unnamed, non-inheritable job.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: CreateJobObjectW returned a new owned handle, transferred exactly once.
        let job = Job(Arc::new(unsafe { OwnedHandle::from_raw_handle(handle) }));
        // SAFETY: zero is a valid default for JOBOBJECT_EXTENDED_LIMIT_INFORMATION.
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: the pointer/size describe `limits`, and the job handle stays open.
        let set = unsafe {
            SetInformationJobObject(
                job.0.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast::<c_void>(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if set == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    pub fn handle(&self) -> Arc<OwnedHandle> {
        Arc::clone(&self.0)
    }

    pub fn terminate(&self) {
        // SAFETY: the shared owned handle is open for the duration of this call.
        unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use portable_pty::{CommandBuilder, PtySize, native_pty_system};
    use windows_sys::Win32::System::JobObjects::IsProcessInJob;

    fn pty() -> portable_pty::PtyPair {
        native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap()
    }

    #[test]
    fn shell_is_in_its_private_job_when_process_creation_returns() {
        let job = Job::new().unwrap();
        let pair = pty();
        let mut command = CommandBuilder::new("cmd.exe");
        command.args(["/d", "/c", "set /p tc_job_wait="]);
        command.set_windows_job(job.handle());
        let mut child = pair.slave.spawn_command(command).unwrap();
        let mut member = 0;
        // SAFETY: the child and job retain both handles, and `member` is a writable BOOL.
        let queried = unsafe { IsProcessInJob(child.as_raw_handle().unwrap(), job.0.as_raw_handle(), &mut member) };
        job.terminate();
        child.wait().unwrap();
        assert_ne!(queried, 0);
        assert_ne!(
            member, 0,
            "the child must already belong to this job before startup can escape it"
        );
    }

    #[test]
    fn invalid_job_rejects_creation_without_running_the_shell_command() {
        let pair = pty();
        let marker = std::env::temp_dir().join(format!("tc-uncontained-{}.txt", uuid::Uuid::new_v4()));
        let mut command = CommandBuilder::new("cmd.exe");
        command.args(["/d", "/c", &format!("echo uncontained>\"{}\"", marker.display())]);
        // A valid owned file handle is deliberately the wrong kernel object type for a job.
        // The OS must reject it before a child can execute the marker command.
        let not_a_job: OwnedHandle = std::fs::File::open("NUL").unwrap().into();
        command.set_windows_job(Arc::new(not_a_job));
        let spawned = pair.slave.spawn_command(command);
        let failed = spawned.is_err();
        if let Ok(mut child) = spawned {
            let _ = child.kill();
            let _ = child.wait();
        }
        let ran = marker.exists();
        let _ = std::fs::remove_file(marker);
        assert!(
            failed,
            "job assignment must fail process creation, never fall back to an ordinary shell"
        );
        assert!(!ran, "a rejected job must not execute startup code");
    }
}
