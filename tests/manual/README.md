# Native manual checks

## Workspace files

Use an isolated test build and disposable files. A manual native run should save
an ordinary workspace containing an image, export a portable copy, then open that
portable file in a fresh profile. Observe that the image renders and every saved
terminal remains stopped. Close the app normally and check its exit status.

Verify the resulting files with:

```sh
node tests/manual/verify-workspace-roundtrip.cjs \
    .cache/native-file-check/native-save.terminalcanvas \
    .cache/native-file-check/native-portable.terminalcanvas \
    .cache/tauri-smoke-profile/assets \
    .cache/native-file-check/rust-portable-import-profile
```

The four arguments are the ordinary save, portable export, original assets
directory, and restored profile directory. The profile must contain
`workspace.terminalcanvas` and `assets/`. The command reads the supplied files,
uses a temporary directory for legacy image extraction, and removes that directory
on completion. It uses the frozen Node oracle after cutover, or the unchanged
reference modules during migration.

The verifier compares the full validated layouts and every referenced image's
bytes, and prints a JSON result with content hashes. It requires an embedded image,
so an empty workspace cannot accidentally pass this check. Save the result under
`.cache/` and record the separate native observations in the migration plan.
The verifier does not prove that a dialog opened, that an image rendered, that no
process launched, or that another OS works; verify those at their own boundaries.

## Bash session restoration

Close all test apps and archive any previous `.cache/tauri-restoration-profile`
and `.cache/native-cli-check` directories. Prepare two stopped cards and local
Claude/Codex stand-ins with `node tests/manual/prepare-cli-restoration.cjs`.
The script refuses existing test directories and never launches the application.

Use an `e2e` build compiled from this checkout so the isolated profile flags are
active. Set `TC_MANUAL_APP` to that test bundle's executable, then launch:

```sh
SHELL="$PWD/.cache/native-cli-check/tools/bash" \
PATH="$PWD/.cache/native-cli-check/tools:/usr/bin:/bin:/usr/sbin:/sbin" \
TC_MANUAL_PHASE=capture \
/usr/bin/env -u BASH_ENV -u ENV "$TC_MANUAL_APP" --restoration-smoke=save
```

The Bash wrapper skips login profiles and checks both executable paths before
each shell starts. Stand-ins use an absolute Node executable and only local files
and the native hook. The workspace's project directory contains Thai, Chinese,
and emoji characters. Windows uses `tests/e2e/restoration.test.cjs` instead.

1. Observe zero running terminals, then click Start on each native card. Run
   `node tests/manual/verify-cli-restoration.cjs capture` to record saved IDs.
2. Close through the native confirmation, verify exit 0, and relaunch with the
   same environment but `TC_MANUAL_PHASE=resume` and `--restoration-smoke=reopen`.
   Observe zero running terminals and Resume buttons. Run the verifier with
   `reopen`; no shell or provider should have run during reopening.
3. Click Resume on each card and run the verifier with `resume`. The recorded
   arguments must use the exact canonical IDs and original working directories.
4. Stop each card, then choose Start fresh shell. Run the verifier with `fresh`;
   six shells have started across both launches, but only four provider calls
   exist and saved metadata remains unchanged.
5. Close through confirmation, check exit 0, and run the verifier with `closed`.
   All six observed shell PIDs must be gone. Keep the reports under `.cache/`.

The verifier checks files and observed process IDs. Record native running counts,
button labels/actions, and application exit codes separately; its results do not
prove Windows behavior or the full manual desktop pass.

## Preserve the macOS clipboard during native checks

Compile the guard with Xcode command line tools and test a private pasteboard:

```sh
mkdir -p .cache/native-board-check
xcrun swiftc -module-cache-path .cache/swift-module-cache \
    tests/manual/macos-clipboard-guard.swift -o .cache/native-board-check/clipboard-guard
.cache/native-board-check/clipboard-guard --self-test
.cache/native-board-check/clipboard-guard --access-check
```

The private self-test covers multiple items, text/HTML/binary formats, Unicode,
and restoring an empty clipboard. CI runs only this private test. The access check
reads permission metadata; it does not read clipboard contents or change settings.
On recent macOS, `--guard` requires access to be already allowed and exits before
reading or changing the clipboard otherwise.

Start `--guard` with stdin kept open and wait for `CLIPBOARD_SAVED` before native
copy/cut/paste tests. It materializes every item/format into memory and neither
prints nor persists the user's data. Commands are one per line:

- `SET_TEXT <base64 UTF-8>` sets known test text.
- `EXPECT_TEXT <base64 UTF-8>` reports only match/mismatch, never the clipboard text.
- `SET_PNG <absolute path>` sets a local PNG test image.
- `RESTORE` restores the saved native formats, verifies their bytes, and exits.

Stdin EOF also restores the clipboard. Keep the process alive until it reports
`CLIPBOARD_RESTORED_AND_VERIFIED`; do not terminate it with SIGKILL. A snapshot
failure happens before mutation. A command failure keeps the saved snapshot for
restoration. The guard's successful checks do not prove board/xterm clipboard
behavior; perform and record those native UI checks separately.

## Remaining macOS folder-picker observation

Use the isolated test app, with no terminals running. Open New terminal, type
`.cache/final-mac-pickers/project ไทย 工作 🚀` as an absolute working directory,
and click Browse. Observe that the native directory picker starts there; cancel
it and confirm the field is unchanged. Browse again and select its `picked folder`
subdirectory; confirm the full selected path fills the field. Cancel the terminal
creation dialog and close the app. No provider or terminal needs to start.

Computer Use could not locate the candidate window for this last observation;
that failed attempt is not recorded as a native dialog pass. The user already
verified Finder-to-canvas image drop. See the separate [Windows 11 checklist](windows11-checklist.md)
for the clean-machine and eight-step compatibility checks.
