# Frozen JavaScript behavior oracle

These standalone modules are the pre-migration behavior captured from the Electron-era host at
commit f489d3b. They are test inputs for `scripts/capture-golden.cjs`, not an application host.
There is no Electron main process, preload, node-pty manager, or Electron dependency here.

The Rust golden tests replay the resulting fixtures. Keeping this oracle lets `--check` continue
proving fixture reproducibility after the runtime host has been deleted. It uses only Node's built-in
modules, writes only controlled temporary fixtures, and is excluded from the Tauri frontend/bundles.
Do not import it from the renderer or production Rust host; new behavior belongs in Rust tests.
