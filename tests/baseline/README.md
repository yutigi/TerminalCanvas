# Windows JavaScript baseline

`node scripts/capture-windows-baseline.cjs` captures the Phase 0 baseline on
native Windows with Node 22/npm 10, the C++ build tools, and PowerShell 7 available.
Use a fresh checkout or archive an existing `.cache/windows-baseline` first; the
command refuses to reuse that directory. It does not open a normal user profile.

The command exports the exact JavaScript commit pinned in
`tests/visual/reference.json`, installs that revision's locked dependencies,
verifies node-pty in Electron, and runs its original unit, native smoke, and
two-launch restoration suites. It then measures three launches with four real,
idle PowerShell terminals and builds the original portable distribution with
publishing disabled. Runtime and test source hashes must remain unchanged.

The bootstrap observes the original host through its existing renderer/manager
interfaces. Test PowerShell sessions use `-NoProfile`, matching the Rust test
host. Test shells disable PSReadLine file history and predictions using the same
startup fixture in both hosts. Restoration refuses to spawn unless every PATH spelling starts with the
fixture's local CLI directory and its Claude stand-in exists. No real provider
is invoked. All workspaces, generated tools, images, and app storage stay in the
fresh baseline directory.

The original smoke clipboard fixture cannot snapshot an empty native clipboard
item. Before smoke, the existing native Windows guard materializes all original
formats in a separate process; the bootstrap then supplies a known text item.
The guard restores the original clipboard after the Electron child ends, including
failure or parent-pipe EOF. No clipboard data is printed or written to disk, and
the archived smoke source and assertions stay unchanged. The guard log must
confirm restoration before smoke is accepted.

The native smoke window reapplies the original application's requested 1500×960
outer size. Windows otherwise clamps its initial window to the hosted display,
covering fixed selection/link coordinates with floating controls. For restoration,
the Windows line editor can drop a non-BMP character from a standalone typed `cd`.
The bootstrap recognizes only that complete generated command and constructs the
same UTF-8 folder argument inside PowerShell. Thai, Chinese, and emoji remain in
the actual folder and every original metadata assertion; other input is unchanged.
The Rust suite separately hashes direct UTF-8 input through a controlled native
child and retains the complete Unicode cwd/restore checks.

`report.json` records test counts, each step's exit status, OS/CPU/RAM/Node
versions, three startup timings, nine native process-tree samples, package sizes,
and source-integrity checks. It also records the harness commit, Windows edition,
and each measured window's outer/content dimensions. Startup runs from spawning the Electron process to
the renderer's ready state. Each memory sample includes the desktop host, browser
children, ConPTY descendants, and all four shells; it excludes the sampling
PowerShell process and its descendants. Private commit and summed working sets
are reported separately, since working sets may count shared pages more than
once. Every measured run must close normally and leave all four shell PIDs gone.

These timings and memory figures describe the unpackaged development host with
test instrumentation and profiles skipped. The machine's OS/file caches are not
flushed. Compare them with the same Rust development configuration and measurement
boundary; they do not establish release startup, resident-memory savings, or
clean Windows 11 behavior. The portable EXE size and unpacked app bytes describe
the actual original distribution built separately. Keep the raw samples when
comparing distributions rather than applying a threshold across different CI
machines.

The `Windows JavaScript baseline` workflow uploads reports, logs, screenshots,
and a separate original portable EXE for later Windows 11 compatibility checks.
It runs when the baseline harness/reference changes and can also be dispatched
after its workflow is available on the default branch. The first native execution
is required before treating this implementation as recorded baseline evidence.

The [first recorded Windows baseline](../../docs/windows-migration-baseline.md)
passed the complete native sequence. To compare both development hosts on the
same runner, dispatch the workflow with `compare_rust=true`. Locally on Windows,
build the Rust `e2e` app/hook and install root dependencies, then run the capture
with `--compare-rust`, followed by `node scripts/measure-windows-rust.cjs`.
This mode uses the same CDP readiness observer for both hosts, rejects mismatched
viewports or source revisions, and uploads `comparison.json` plus native samples.
Its instrumentation is included in timing/memory figures; release and clean
Windows 11 validation remain separate.
