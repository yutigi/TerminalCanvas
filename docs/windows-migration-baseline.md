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

The Rust release distribution comparison and clean Windows 11 installer/portable
and interoperability checks remain open.
