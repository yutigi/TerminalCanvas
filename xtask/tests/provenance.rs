//! A cached task binary must use the invocation's checkout, not its compiled-in source path.
use std::process::Command;

#[test]
fn syntax_checks_the_runtime_manifest_workspace_even_when_the_binary_was_built_elsewhere() {
    let root = std::env::temp_dir().join(format!("tc-task-provenance-{}", std::process::id()));
    for folder in ["src", "scripts", "tests", "xtask"] {
        std::fs::create_dir_all(root.join(folder)).unwrap();
    }
    std::fs::write(root.join("package.json"), "{}").unwrap();
    let invalid = root.join("src/only-in-invocation.js");
    std::fs::write(&invalid, "const = ;").unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_xtask"))
        .arg("syntax")
        .env("CARGO_MANIFEST_DIR", root.join("xtask"))
        .output()
        .unwrap();
    std::fs::remove_dir_all(&root).unwrap();
    assert!(
        !result.status.success(),
        "the task must reject the invocation's invalid source"
    );
    assert!(String::from_utf8_lossy(&result.stderr).contains("only-in-invocation.js"));
}
