//! Copies the pinned xterm.js files into `src/vendor/` (Tauri cannot serve `../node_modules`), and
//! declares the app's commands so each needs a capability permission.

use std::path::Path;

/// `node_modules` path → `src/vendor` name.
const XTERM: [(&str, &str); 3] = [
    ("@xterm/xterm/lib/xterm.js", "xterm.js"),
    ("@xterm/xterm/css/xterm.css", "xterm.css"),
    ("@xterm/addon-fit/lib/addon-fit.js", "addon-fit.js"),
];

const COMMANDS: &[&str] = &[
    "initialize",
    "create_card",
    "autosave",
    "save",
    "save_as",
    "export",
    "open",
    "new",
    "close",
    "duplicate_directory",
    "start",
    "stop",
    "pick_folder",
    "import_image",
    "pick_image",
    "unused_images",
    "delete_unused_images",
    "open_link",
    "clipboard_read",
    "clipboard_write",
    "input",
    "resize",
    "ack",
    "e2e_state",
    "e2e_focus",
    "e2e_dialog",
    "e2e_request_close",
];

fn vendor_xterm() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri is in the repository");
    let vendor = root.join("src").join("vendor");
    std::fs::create_dir_all(&vendor).expect("src/vendor can be created");
    for (source, name) in XTERM {
        let source = root.join("node_modules").join(source);
        println!("cargo:rerun-if-changed={}", source.display());
        let bytes =
            std::fs::read(&source).unwrap_or_else(|_| panic!("{} is missing: run npm ci first", source.display()));
        let target = vendor.join(name);
        // Unchanged files keep their timestamps, so the embedded assets are not rebuilt.
        if std::fs::read(&target).ok().as_deref() != Some(&bytes[..]) {
            std::fs::write(&target, bytes).expect("src/vendor is writable");
        }
    }
}

fn main() {
    vendor_xterm();
    let manifest = tauri_build::AppManifest::new().commands(COMMANDS);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest)).expect("Tauri build steps");
}
