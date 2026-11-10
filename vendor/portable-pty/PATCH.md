# portable-pty 0.9.0 Windows job assignment patch

Upstream: https://crates.io/crates/portable-pty/0.9.0

Original crate archive SHA-256: `b4a596a2b3d2752d94f51fac2d4a96737b8705dddd311a32b9af47211f08671e`.

The upstream MIT license is preserved in `LICENSE.md`. Source and examples are copied from that
crate; only the three files below are changed. Cargo selects this copy through the workspace's
`[patch.crates-io]`; no install-time mutation of downloaded dependencies is needed.

- `src/cmdbuilder.rs`: an optional Windows job owns an `Arc<OwnedHandle>` through process creation.
  Cloning retains the handle; serde deliberately omits this process-local resource. Non-Windows
  behavior is unchanged.
- `src/win/procthreadattr.rs`: adds `PROC_THREAD_ATTRIBUTE_JOB_LIST`, retaining its handle array
  until the attribute list is destroyed. The attribute buffer is initialized rather than using
  `set_len` on uninitialized storage.
- `src/win/psuedocon.rs`: supplies the job attribute with the pseudoconsole to `CreateProcessW`.

Terminal Canvas creates a kill-on-close job before spawning, requires successful creation and
assignment, and keeps the handle for the whole terminal lifetime. Assigning after spawn allowed
startup children to escape the job; treating assignment failure as optional violated cleanup.
An invalid job now fails process creation instead of leaving an uncontained shell running.

The API and value-lifetime contract are documented by Microsoft:
https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute

Windows-only tests in `crates/tc-pty/src/job.rs` check membership immediately after spawn and verify
that a non-job handle fails without executing a marker command. The existing real-PTY and desktop
E2E tests cover Stop, app close, and host termination. These native checks must run on Windows;
source type-checking on macOS is not execution evidence.
