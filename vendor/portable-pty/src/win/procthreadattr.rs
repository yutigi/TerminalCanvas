use crate::win::psuedocon::HPCON;
use anyhow::{ensure, Error};
use std::io::Error as IoError;
use std::os::windows::io::{AsRawHandle, OwnedHandle};
use std::{mem, ptr};
use winapi::shared::minwindef::DWORD;
use winapi::um::processthreadsapi::*;
use winapi::um::winnt::HANDLE;

const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE: usize = 0x00020016;
const PROC_THREAD_ATTRIBUTE_JOB_LIST: usize = 0x0002000d;

pub struct ProcThreadAttributeList {
    data: Vec<u8>,
    // UpdateProcThreadAttribute borrows its value until DeleteProcThreadAttributeList.
    // A box keeps the job-handle array at a stable address when this list is moved.
    job_handles: Option<Box<[HANDLE; 1]>>,
}

impl ProcThreadAttributeList {
    pub fn with_capacity(num_attributes: DWORD) -> Result<Self, Error> {
        let mut bytes_required: usize = 0;
        unsafe {
            InitializeProcThreadAttributeList(
                ptr::null_mut(),
                num_attributes,
                0,
                &mut bytes_required,
            )
        };
        let mut data = vec![0u8; bytes_required];

        let attr_ptr = data.as_mut_slice().as_mut_ptr() as *mut _;
        let res = unsafe {
            InitializeProcThreadAttributeList(attr_ptr, num_attributes, 0, &mut bytes_required)
        };
        ensure!(
            res != 0,
            "InitializeProcThreadAttributeList failed: {}",
            IoError::last_os_error()
        );
        Ok(Self {
            data,
            job_handles: None,
        })
    }

    pub fn as_mut_ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.data.as_mut_slice().as_mut_ptr() as *mut _
    }

    pub fn set_job(&mut self, job: &OwnedHandle) -> Result<(), Error> {
        let mut handles = Box::new([job.as_raw_handle() as HANDLE]);
        // The caller keeps the owned handle alive through CreateProcessW. The value array
        // remains alive until the attribute list is deleted (including on any error path).
        let res = unsafe {
            UpdateProcThreadAttribute(
                self.as_mut_ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST,
                handles.as_mut_ptr().cast(),
                mem::size_of_val(handles.as_ref()),
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        ensure!(
            res != 0,
            "UpdateProcThreadAttribute(JobList) failed: {}",
            IoError::last_os_error()
        );
        self.job_handles = Some(handles);
        Ok(())
    }

    pub fn set_pty(&mut self, con: HPCON) -> Result<(), Error> {
        let res = unsafe {
            UpdateProcThreadAttribute(
                self.as_mut_ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                con,
                mem::size_of::<HPCON>(),
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        ensure!(
            res != 0,
            "UpdateProcThreadAttribute failed: {}",
            IoError::last_os_error()
        );
        Ok(())
    }
}

impl Drop for ProcThreadAttributeList {
    fn drop(&mut self) {
        unsafe { DeleteProcThreadAttributeList(self.as_mut_ptr()) };
    }
}
