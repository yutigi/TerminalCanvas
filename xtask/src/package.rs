//! Build the Windows installer and a portable zip containing just the app and its hook.
use std::path::{Path, PathBuf};
use std::process::Command;

const TARGET: &str = "x86_64-pc-windows-msvc";
const CLI_VERSION: &str = "2.12.4";

fn run(root: &Path, command: &mut Command) -> Result<(), String> {
    println!("> {command:?}");
    let status = command.current_dir(root).status().map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("Command failed: {status}"))
    }
}

fn target_dir(root: &Path, cargo: &str) -> Result<PathBuf, String> {
    let output = Command::new(cargo)
        .args(["metadata", "--format-version", "1", "--no-deps"])
        .current_dir(root)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    let metadata: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())?;
    metadata["target_directory"]
        .as_str()
        .map(PathBuf::from)
        .ok_or("Cargo did not report its target directory.".into())
}

fn copy(source: &Path, target: &Path) -> Result<(), String> {
    std::fs::copy(source, target)
        .map(|_| ())
        .map_err(|error| format!("{} → {}: {error}", source.display(), target.display()))
}

fn quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "''"))
}

pub fn windows(root: &Path, cargo: &str) -> Result<(), String> {
    if !cfg!(windows) {
        return Err("Windows packaging must run on Windows with the MSVC Build Tools and Windows SDK.".into());
    }
    let output = Command::new(cargo)
        .args(["tauri", "--version"])
        .current_dir(root)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success()
        || String::from_utf8_lossy(&output.stdout).split_whitespace().last() != Some(CLI_VERSION)
    {
        return Err(format!(
            "Install the pinned Tauri 2 CLI: cargo install tauri-cli --version {CLI_VERSION} --locked"
        ));
    }
    super::icons::run(root, true)?;
    let target = target_dir(root, cargo)?;
    run(
        root,
        Command::new(cargo)
            .args([
                "build",
                "--locked",
                "-p",
                "tc-hook",
                "--release",
                "--target",
                TARGET,
                "--config",
            ])
            .arg(format!(
                "target.{TARGET}.rustflags=[\"-C\",\"target-feature=+crt-static\"]"
            )),
    )?;
    let hook = target.join(TARGET).join("release/tc-hook.exe");
    let binaries = root.join("src-tauri/binaries");
    std::fs::create_dir_all(&binaries).map_err(|error| error.to_string())?;
    copy(&hook, &binaries.join(format!("tc-hook-{TARGET}.exe")))?;
    // This overlay is deliberately not named tauri.windows.conf.json: ordinary cargo run/test
    // must not require an already-built release sidecar. The CLI merges it for packaging only.
    run(
        root,
        Command::new(cargo)
            .args(["tauri", "build", "--target", TARGET, "--config"])
            .arg(root.join("src-tauri/bundle.windows.json"))
            .args(["--", "--locked"]),
    )?;
    let built = target.join(TARGET).join("release");
    // CI has the MSVC redistributable installed. Inspect the actual shipping
    // binaries so a sidecar cannot silently depend on that developer machine.
    for binary in [built.join("Terminal Canvas.exe"), hook.clone()] {
        run(
            root,
            Command::new("node")
                .args([
                    "-e",
                    "const fs=require('node:fs'); const {imports}=require('./scripts/package-windows-test.cjs'); console.log(JSON.stringify({binary:process.argv[1],imports:imports(fs.readFileSync(process.argv[1]))}));",
                ])
                .arg(binary),
        )?;
    }
    let release = root.join("release");
    std::fs::create_dir_all(&release).map_err(|error| error.to_string())?;
    let installer = format!("Terminal Canvas_{}_x64-setup.exe", env!("CARGO_PKG_VERSION"));
    copy(&built.join("bundle/nsis").join(&installer), &release.join(&installer))?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let stage = std::env::temp_dir().join(format!("tc-portable-{}-{nonce}", std::process::id()));
    std::fs::create_dir(&stage).map_err(|error| error.to_string())?;
    let result = (|| {
        let app = stage.join("Terminal Canvas.exe");
        let sidecar = stage.join("tc-hook.exe");
        copy(&built.join("Terminal Canvas.exe"), &app)?;
        copy(&hook, &sidecar)?;
        let zip = release.join(format!(
            "Terminal Canvas_{}_x64_portable.zip",
            env!("CARGO_PKG_VERSION")
        ));
        let script = format!(
            "$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath @({}, {}) -DestinationPath {} -Force",
            quote(&app),
            quote(&sidecar),
            quote(&zip)
        );
        run(
            root,
            Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", &script]),
        )?;
        println!("Windows installer and portable zip are in {}.", release.display());
        Ok(())
    })();
    let cleanup = std::fs::remove_dir_all(&stage).map_err(|error| error.to_string());
    result.and(cleanup)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn powershell_paths_are_literal_and_escape_apostrophes() {
        assert_eq!(
            quote(Path::new("C:/project's files/tc-hook.exe")),
            "'C:/project''s files/tc-hook.exe'"
        );
    }
}
