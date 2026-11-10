# Windows migration baseline

The first complete reference capture is [run 42873175044](https://github.com/yutigi/TerminalCanvas/actions/runs/42873175044).
Its `windows-electron-baseline` artifact contains the raw report, process samples,
native screenshots, and logs. `windows-electron-reference` contains the original
portable EXE, built without publishing a release.

| Evidence | Recorded value |
| --- | --- |
| Original JavaScript revision | `f489d3b726690ffa3b0132fdc400f8dc31a460db` |
| Capture harness revision | `aebf72646e68be1d5dc6072919aff1451532a932` |
| Platform | Windows Server 2025 Datacenter, build 26100, x64 |
| Runner | 4 vCPUs on an AMD EPYC 7763 host, 17,174,360,064 bytes RAM |
| Node | 22.23.4 |
| Original unit suite | 189 passed, no failures/skips |
| Native desktop smoke | Passed, including directories, creation, clipboard, links, selection, zoom, board items, and PTY cleanup |
| Native restoration | Save/reopen passed; exact Claude ID resume, fresh shell, immediate recovery, and close flush |
| Original source integrity | 57 source/test/manifest files retained their hashes |
| Clipboard guard | Native restoration acknowledged |
| Portable EXE | 114,453,226 bytes (109.2 MiB) |
| Unpacked application | 407,690,815 bytes (388.8 MiB) |
| Instrumented startup samples | 391, 403, 393 ms; median 393 ms |
| Four idle PowerShell shells | Median private commit 571,125,760 bytes (544.7 MiB) |
| Summed working sets | Median 838,860,800 bytes (800.0 MiB) |
| Measured outer/content size | 1024×720 / 1008×681 |

The startup values use the original capture's renderer-ready observation. Memory
uses nine native process-tree samples across three launches; the raw samples
include four Electron processes, four PowerShell processes, and four console
hosts. The sampler and its descendants are excluded. Working sets can count
shared pages more than once; private commit is recorded separately.

Both test hosts skip PowerShell profiles, file history, and predictions. The
reference's fixed native smoke fixtures reapply its requested 1500×960 window
size, and a native guard restores the original clipboard after controlled text
input. The full Unicode restoration directory is constructed inside PowerShell
to avoid its line editor dropping a non-BMP character. Archived source and
assertions remain unchanged.

These are unpackaged, instrumented development-host measurements with warm
OS/file caches. They do not establish release startup, physical resident-memory
savings, or a clean Windows 11 pass. The distribution sizes were measured from
the separately built original portable package.

For a paired comparison, dispatch `Windows JavaScript baseline` with
`compare_rust=true`. That run builds the Rust test host, captures the reference
with the same external CDP renderer-ready observer, and measures three Rust
launches with four idle PowerShell terminals. It requires matching content
viewports and the same source commit, includes WebView2 browser processes in the
native sampler, checks normal shutdown and all shell PIDs, and uploads
`comparison.json` alongside the raw reference report. Compare timings from that
shared-observer run rather than mixing them with the original 393 ms observation.

The Rust distribution was built after the complete three-platform validation and
ten native desktop suites in [run 42876975230](https://github.com/yutigi/TerminalCanvas/actions/runs/42876975230).
The reusable workflow verified the caller's validated SHA before packaging normal
release binaries without the test-only feature.

| Distribution | Bytes | Scope |
| --- | ---: | --- |
| Original Electron portable EXE | 114,453,226 | Self-extracting portable application |
| Original Electron unpacked app | 407,690,815 | Includes its bundled Chromium/Node runtime |
| Rust NSIS installer | 3,153,585 | Can download the system WebView2 Runtime if absent |
| Rust portable ZIP | 4,490,586 | Requires the system WebView2 Runtime |
| Rust portable application EXE | 13,457,920 | x64 normal release host |
| Rust hook EXE | 329,216 | x64 colocated sidecar |

The Rust ZIP has exactly those two executables. Their combined unpacked size is
13,787,136 bytes. This is application distribution size, not the total disk cost
of the separately installed WebView2 Runtime, and the two portable formats use
different compression/launch mechanisms. The installer SHA-256 is
`dde88fb453e723febd558e4302fb15651ac30ab872d5cc931df6d6b5f0898b8d`;
the portable ZIP SHA-256 is
`ecddd9f734d9e4f09882731ddefa91b8e8d726cf0f0fc7385654f5bde611dba1`.
[Download the reviewed artifacts](https://github.com/yutigi/TerminalCanvas/actions/runs/42876975230/artifacts/13793932227).

The first shared-observer development comparison, [run 42878494112](https://github.com/yutigi/TerminalCanvas/actions/runs/42878494112),
recorded median ready observations of 528 ms for Electron and 721 ms for the
Rust debug/e2e host; private commit was 575,774,720 versus 497,836,032 bytes,
and summed working sets were 840,466,432 versus 852,279,296 bytes. Thus this run
showed slower startup and slightly higher summed working sets despite lower
private commit. It does not demonstrate release startup or resident-memory gains.
A follow-up handshake observes the empty ready UI before either host starts its
shells, eliminating asymmetric shell-startup contention. Its first rerun stalled
on the second reference launch; that refinement has no completed comparison yet.
The earlier complete raw run is retained with this limitation.

Clean Windows 11 normal-user installer/portable execution, the separate full
22-case Windows 11 suite, and automatic Electron autosave/image interoperability
checks remain open. The [manual checklist](../tests/manual/windows11-checklist.md)
and read-only PowerShell checker separate file equality from native observations.
