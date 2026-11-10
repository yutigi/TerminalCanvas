# Clean Windows 11 migration check

Use a clean Windows 11 VM/account with no existing Terminal Canvas data. Rust,
Node, and MSVC must not be needed. Run as a normal user. Keep one app open at a
time; the Electron and Rust apps intentionally share recovery data.

Downloads:

- [Rust NSIS installer and portable ZIP](https://github.com/yutigi/TerminalCanvas/actions/runs/42876975230/artifacts/13793932227)
- [Original Electron portable EXE](https://github.com/yutigi/TerminalCanvas/actions/runs/42873175044/artifacts/13790752385)

The Rust artifact contains `Terminal Canvas_0.1.0_x64-setup.exe` and
`Terminal Canvas_0.1.0_x64_portable.zip`. The portable ZIP must contain
`Terminal Canvas.exe` and `tc-hook.exe` together. This kit's image workspace
contains only stopped plain-shell cards and synthetic data; it invokes no AI CLI.

1. Extract the Rust portable ZIP into a folder with spaces/Unicode. Launch
   `Terminal Canvas.exe`. Confirm the app opens without development tools.
   Open this kit's `image-workspace.terminalcanvas`. Observe the colored image,
   note, connector/arrow, matching layout, and **0 running** terminals.
2. Start the plain shell and run `Write-Output TC_WIN11_SHELL_OK`. Check typing,
   cwd display, text selection/copy/paste, canvas zoom, Focus, and Stop. Check
   note editing/style, grouping/undo/redo, drawing/connecting items, minimap,
   native image paste and file drop. Close the app; its shell must be gone.
3. Run the NSIS installer and launch the installed app. Confirm it opens without
   Rust/Node/MSVC and can render the saved image. Record whether WebView2 was
   already installed or the installer downloaded it. If it was already present,
   record that the missing-runtime path was not exercised; do not remove system
   components just for this check.
4. Close Rust. Launch the original Electron portable EXE. Open the kit workspace
   afresh, rename it **Win11 Electron saved**, and leave its terminal stopped.
   Save to `electron-save.terminalcanvas`, then use **Export portable copy** to
   produce `electron-export.terminalcanvas`. Observe the image, then close.
5. Launch the installed Rust app normally. **Before opening any file**, confirm
   it automatically restores **Win11 Electron saved**, its image and layout,
   with **0 running** terminals. If it restores a different/empty workspace,
   record that failure before continuing. Export to
   `rust-roundtrip.terminalcanvas` without starting or modifying the card.
6. Close Rust and reopen the portable Rust EXE. Confirm the same automatic
   restoration with the image and stopped cards. Close it normally.
7. Run the read-only checker in Windows PowerShell:

   ```powershell
   powershell.exe -NoProfile -File .\verify-windows-files.ps1 `
       -ElectronExport .\electron-export.terminalcanvas `
       -RustExport .\rust-roundtrip.terminalcanvas
   ```

   It compares the full saved layout and all embedded image bytes, independent of
   JSON property order. It records the Windows edition/build and which app data
   folders contain recovery files. It does not start an app or alter data.

Reply with the Windows edition/build, each numbered step's pass/fail, checker
result, WebView2 status, and any exact errors. File equivalence does not replace
the separate native rendering/automatic-restoration observations.

The current artifacts are migration validation builds. Electron remains the
default in the source checkout until the remaining gates and final cutover pass.
