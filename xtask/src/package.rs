//! Build the desktop packages for the current platform, each with the `tc-hook` sidecar:
//!
//! - Windows: the NSIS installer and a portable zip containing just the app and its hook.
//! - macOS: the app bundle, as a disk image for first installs.
//! - Linux: an AppImage and a Debian package.
//!
//! With `--updater`, the Tauri CLI also signs every package the auto-updater installs (the
//! Windows installer, a `.app.tar.gz` of the macOS bundle, the AppImage, and the Debian package).
//! That needs `TAURI_SIGNING_PRIVATE_KEY`, plus `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if the key
//! has one. Packages land in `release/`, named as `release` expects them.
use std::path::{Path, PathBuf};
use std::process::Command;

pub const CLI_VERSION: &str = "2.12.4";
pub const PRODUCT: &str = "Terminal Canvas";
const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Os {
    Windows,
    Mac,
    Linux,
}

/// The targets we ship, and the name each one's packages use for the architecture.
const TARGETS: [(&str, Os, &str); 4] = [
    ("x86_64-pc-windows-msvc", Os::Windows, "x64"),
    ("aarch64-apple-darwin", Os::Mac, "aarch64"),
    ("x86_64-apple-darwin", Os::Mac, "x64"),
    ("x86_64-unknown-linux-gnu", Os::Linux, "amd64"),
];

#[derive(Debug, PartialEq, Eq)]
pub struct Options {
    target: &'static str,
    os: Os,
    arch: &'static str,
    updater: bool,
}

impl Options {
    /// `[--target <triple>] [--updater]`. The default target is this machine's.
    pub fn parse(args: &[String]) -> Result<Options, String> {
        let mut target = host_target();
        let mut updater = false;
        let mut args = args.iter();
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--target" => target = args.next().map(String::as_str),
                "--updater" => updater = true,
                other => return Err(format!("Unknown package option: {other}")),
            }
        }
        let target = target.ok_or("Pass --target with one of the supported targets.")?;
        let (target, os, arch) = TARGETS.into_iter().find(|(name, ..)| *name == target).ok_or_else(|| {
            let names: Vec<_> = TARGETS.iter().map(|(name, ..)| *name).collect();
            format!("Unsupported target {target}. Supported: {}", names.join(", "))
        })?;
        Ok(Options {
            target,
            os,
            arch,
            updater,
        })
    }

    pub fn windows() -> Options {
        Options::parse(&["--target".into(), TARGETS[0].0.into()]).expect("the Windows target is supported")
    }
}

fn host_target() -> Option<&'static str> {
    if cfg!(all(windows, target_arch = "x86_64")) {
        Some("x86_64-pc-windows-msvc")
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some("aarch64-apple-darwin")
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        Some("x86_64-apple-darwin")
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Some("x86_64-unknown-linux-gnu")
    } else {
        None
    }
}

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

/// Copies a package and, for updater builds, its signature.
fn copy_signed(source: &Path, target: &Path, updater: bool) -> Result<(), String> {
    copy(source, target)?;
    if updater {
        copy(&signature(source), &signature(target))?;
    }
    Ok(())
}

fn signature(package: &Path) -> PathBuf {
    let mut name = package.as_os_str().to_owned();
    name.push(".sig");
    PathBuf::from(name)
}

fn quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "''"))
}

/// What a package is called in `release/`: `Terminal Canvas_<version>_<arch><suffix>`.
pub fn package_name(version: &str, arch: &str, suffix: &str) -> String {
    format!("{PRODUCT}_{version}_{arch}{suffix}")
}

pub fn package(root: &Path, cargo: &str, options: &Options) -> Result<(), String> {
    let host = match options.os {
        Os::Windows => cfg!(windows),
        Os::Mac => cfg!(target_os = "macos"),
        Os::Linux => cfg!(target_os = "linux"),
    };
    if !host {
        return Err(format!(
            "{} packages must be built on that platform: Windows with the MSVC Build Tools and Windows SDK, macOS with the Xcode Command Line Tools, Linux with Tauri's WebKitGTK packages.",
            options.target
        ));
    }
    if options.updater && std::env::var_os("TAURI_SIGNING_PRIVATE_KEY").is_none() {
        return Err("Updater packages are signed with TAURI_SIGNING_PRIVATE_KEY, which is not set.".into());
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
    let triple = options.target;
    let mut hook_build = Command::new(cargo);
    hook_build.args(["build", "--locked", "-p", "tc-hook", "--release", "--target", triple]);
    if options.os == Os::Windows {
        hook_build.arg("--config").arg(format!(
            "target.{triple}.rustflags=[\"-C\",\"target-feature=+crt-static\"]"
        ));
    }
    run(root, &mut hook_build)?;
    let exe = if options.os == Os::Windows { ".exe" } else { "" };
    let hook = target.join(triple).join(format!("release/tc-hook{exe}"));
    let binaries = root.join("src-tauri/binaries");
    std::fs::create_dir_all(&binaries).map_err(|error| error.to_string())?;
    copy(&hook, &binaries.join(format!("tc-hook-{triple}{exe}")))?;
    // These overlays are deliberately not named tauri.<platform>.conf.json: ordinary cargo
    // run/test must not require an already-built release sidecar. The CLI merges them for
    // packaging only.
    let overlay = match options.os {
        Os::Windows => "src-tauri/bundle.windows.json",
        Os::Mac => "src-tauri/bundle.macos.json",
        Os::Linux => "src-tauri/bundle.linux.json",
    };
    let mut build = Command::new(cargo);
    build
        .args(["tauri", "build", "--target", triple, "--config"])
        .arg(root.join(overlay));
    if options.updater {
        build.args(["--config", r#"{"bundle":{"createUpdaterArtifacts":true}}"#]);
    }
    run(root, build.args(["--", "--locked"]))?;
    let built = target.join(triple).join("release");
    let release = root.join("release");
    std::fs::create_dir_all(&release).map_err(|error| error.to_string())?;
    match options.os {
        Os::Windows => windows(root, &built, &hook, &release, options),
        Os::Mac => macos(&built, &release, options),
        Os::Linux => linux(&built, &release, options),
    }?;
    println!("Packages are in {}.", release.display());
    Ok(())
}

fn windows(root: &Path, built: &Path, hook: &Path, release: &Path, options: &Options) -> Result<(), String> {
    // CI has the MSVC redistributable installed. Inspect the actual shipping
    // binaries so a sidecar cannot silently depend on that developer machine.
    for binary in [built.join("Terminal Canvas.exe"), hook.to_path_buf()] {
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
    let installer = package_name(VERSION, options.arch, "-setup.exe");
    copy_signed(
        &built.join("bundle/nsis").join(&installer),
        &release.join(&installer),
        options.updater,
    )?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let stage = std::env::temp_dir().join(format!("tc-portable-{}-{nonce}", std::process::id()));
    std::fs::create_dir(&stage).map_err(|error| error.to_string())?;
    let result = (|| {
        // The bundler restores the unpatched binary after building the installer, so the
        // portable copy reports no bundle type and only links to updates.
        let app = stage.join("Terminal Canvas.exe");
        let sidecar = stage.join("tc-hook.exe");
        copy(&built.join("Terminal Canvas.exe"), &app)?;
        copy(hook, &sidecar)?;
        let zip = release.join(package_name(VERSION, options.arch, "_portable.zip"));
        let script = format!(
            "$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath @({}, {}) -DestinationPath {} -Force",
            quote(&app),
            quote(&sidecar),
            quote(&zip)
        );
        run(
            root,
            Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", &script]),
        )
    })();
    let cleanup = std::fs::remove_dir_all(&stage).map_err(|error| error.to_string());
    result.and(cleanup)
}

fn macos(built: &Path, release: &Path, options: &Options) -> Result<(), String> {
    let bundle = built.join("bundle/macos").join(format!("{PRODUCT}.app"));
    let hook = bundle.join("Contents/MacOS/tc-hook");
    if !hook.is_file() {
        return Err(format!("The app bundle is missing its hook: {}", hook.display()));
    }
    let image = package_name(VERSION, options.arch, ".dmg");
    copy(&built.join("bundle/dmg").join(&image), &release.join(&image))?;
    if options.updater {
        // The bundler names the archive after the app alone; both architectures need their own.
        let archive = built.join("bundle/macos").join(format!("{PRODUCT}.app.tar.gz"));
        copy_signed(
            &archive,
            &release.join(package_name(VERSION, options.arch, ".app.tar.gz")),
            true,
        )?;
    }
    Ok(())
}

fn linux(built: &Path, release: &Path, options: &Options) -> Result<(), String> {
    for (folder, suffix) in [("appimage", ".AppImage"), ("deb", ".deb")] {
        let name = package_name(VERSION, options.arch, suffix);
        copy_signed(
            &built.join("bundle").join(folder).join(&name),
            &release.join(&name),
            options.updater,
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| (*arg).to_owned()).collect()
    }

    #[test]
    fn powershell_paths_are_literal_and_escape_apostrophes() {
        assert_eq!(
            quote(Path::new("C:/project's files/tc-hook.exe")),
            "'C:/project''s files/tc-hook.exe'"
        );
    }

    #[test]
    fn options_name_a_shipped_target_and_whether_to_sign_for_the_updater() {
        let options = Options::parse(&args(&["--target", "x86_64-apple-darwin", "--updater"])).unwrap();
        assert_eq!((options.os, options.arch, options.updater), (Os::Mac, "x64", true));
        assert_eq!(Options::windows().target, "x86_64-pc-windows-msvc");
        assert!(!Options::windows().updater);
        assert!(Options::parse(&args(&["--target", "aarch64-unknown-linux-gnu"])).is_err());
        assert!(Options::parse(&args(&["--target"])).is_err());
        assert!(Options::parse(&args(&["--sign"])).is_err());
    }

    #[test]
    fn package_names_match_the_bundler_and_the_existing_windows_artifacts() {
        assert_eq!(
            package_name(VERSION, "x64", "-setup.exe"),
            format!("Terminal Canvas_{VERSION}_x64-setup.exe")
        );
        assert_eq!(
            package_name(VERSION, "x64", "_portable.zip"),
            format!("Terminal Canvas_{VERSION}_x64_portable.zip")
        );
        assert_eq!(signature(Path::new("a/b.AppImage")), Path::new("a/b.AppImage.sig"));
    }
}
