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

/// Windows keeps running executables locked even when Cargo wants to rebuild them.
#[cfg(windows)]
#[test]
fn task_alias_allows_tests_to_rebuild_the_running_task() {
    let root = std::env::temp_dir().join(format!("tc-task-rebuild-{}", std::process::id()));
    for folder in [".cargo", "src", "tests"] {
        std::fs::create_dir_all(root.join(folder)).unwrap();
    }
    std::fs::write(
        root.join(".cargo/config.toml"),
        include_str!("../../.cargo/config.toml"),
    )
    .unwrap();
    std::fs::write(
        root.join("Cargo.toml"),
        "[package]\nname = 'xtask'\nversion = '0.0.0'\nedition = '2024'\n\n[profile.xtask]\ninherits = 'dev'\n",
    )
    .unwrap();
    std::fs::write(
        root.join("src/main.rs"),
        r#"fn main() {
    // Force the nested test command to rebuild the non-test binary as well.
    let source = std::fs::read_to_string("src/main.rs").unwrap();
    std::fs::write("src/main.rs", format!("{source}\n")).unwrap();
    let status = std::process::Command::new(env!("CARGO"))
        .args(["test", "--quiet"])
        .status()
        .unwrap();
    std::process::exit(status.code().unwrap_or(1));
}
"#,
    )
    .unwrap();
    std::fs::write(
        root.join("tests/rebuild.rs"),
        "#[test]\nfn task_binary_exists() { assert!(std::path::Path::new(env!(\"CARGO_BIN_EXE_xtask\")).is_file()); }\n",
    )
    .unwrap();
    let result = Command::new(env!("CARGO"))
        .arg("xtask")
        .current_dir(&root)
        .env("CARGO_TARGET_DIR", root.join("target"))
        .env("CARGO_NET_OFFLINE", "true")
        .output()
        .unwrap();
    std::fs::remove_dir_all(&root).unwrap();
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
}
