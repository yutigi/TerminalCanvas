//! The renderer keeps `src/item-styles.js`. This loads it with Node and compares it with the Rust
//! constants, so the UI and the host can never offer and accept different styles.

use std::path::Path;
use std::process::Command;

use serde_json::{Value, json};
use tc_core::styles::{COLORED_TYPES, Color, FontSize, GROUP_DEPTH, TEXT_TYPES};

#[test]
fn rust_styles_match_item_styles_js() {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/item-styles.js");
    let output = Command::new("node")
        .args(["-e", "process.stdout.write(JSON.stringify(require(process.argv[1])))"])
        .arg(&script)
        .output()
        .expect("Node.js runs the UI tests and is required for this parity test");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let javascript: Value = serde_json::from_slice(&output.stdout).expect("JSON");
    let rust = json!({
        "COLORS": Color::ALL.iter().map(|c| c.as_str()).collect::<Vec<_>>(),
        "FONT_SIZES": FontSize::ALL.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
        "COLORED_TYPES": COLORED_TYPES,
        "TEXT_TYPES": TEXT_TYPES,
        "GROUP_DEPTH": GROUP_DEPTH,
    });
    assert_eq!(javascript, rust);
}
