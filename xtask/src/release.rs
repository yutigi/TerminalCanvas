//! Assemble a GitHub release from the packages every platform built with `package --updater`.
//!
//! `release --tag v<version> --repo <owner/name> --input <dir> --output <dir> [--date <RFC 3339>]`
//!
//! - Every expected package must be present, so a partial release can't be published.
//! - Each updater signature must verify against the public key in `tauri.conf.json` and name this
//!   version, which the app requires (`requireSignedVersion`).
//! - Files get names GitHub keeps as they are (it would replace spaces).
//! - `latest.json`, the manifest the app reads, points each updater target at its package.
//! - `SHA256SUMS.txt` lists every published file.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::package::{PRODUCT, package_name};

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Packages the updater installs, and the manifest targets that select each one. An app looks
/// for `<os>-<arch>-<bundle type>` first, then `<os>-<arch>`.
const UPDATABLE: [(&str, &str, &[&str]); 5] = [
    ("x64", "-setup.exe", &["windows-x86_64-nsis", "windows-x86_64"]),
    ("aarch64", ".app.tar.gz", &["darwin-aarch64-app", "darwin-aarch64"]),
    ("x64", ".app.tar.gz", &["darwin-x86_64-app", "darwin-x86_64"]),
    ("amd64", ".AppImage", &["linux-x86_64-appimage", "linux-x86_64"]),
    ("amd64", ".deb", &["linux-x86_64-deb"]),
];

/// Downloads for a first install, which the updater doesn't use.
const DOWNLOADS: [(&str, &str); 3] = [("x64", "_portable.zip"), ("aarch64", ".dmg"), ("x64", ".dmg")];

#[derive(Debug, PartialEq, Eq)]
struct Options {
    tag: String,
    repo: String,
    input: PathBuf,
    output: PathBuf,
    date: Option<String>,
}

fn parse(args: &[String]) -> Result<Options, String> {
    let mut values = BTreeMap::new();
    let mut args = args.iter();
    while let Some(flag) = args.next() {
        let name = flag
            .strip_prefix("--")
            .filter(|name| ["tag", "repo", "input", "output", "date"].contains(name))
            .ok_or_else(|| format!("Unknown release option: {flag}"))?;
        let value = args.next().ok_or_else(|| format!("{flag} needs a value"))?;
        values.insert(name, value.clone());
    }
    let mut take = |name: &str| values.remove(name).ok_or_else(|| format!("--{name} is required"));
    Ok(Options {
        tag: take("tag")?,
        repo: take("repo")?,
        input: take("input")?.into(),
        output: take("output")?.into(),
        date: values.remove("date"),
    })
}

/// GitHub replaces spaces in asset names.
fn published_name(name: &str) -> String {
    name.replace(' ', "-")
}

/// The release's files, found anywhere under `input` (each platform's artifact is a folder).
fn find(input: &Path, name: &str) -> Result<PathBuf, String> {
    let mut found = Vec::new();
    let mut folders = vec![input.to_path_buf()];
    while let Some(folder) = folders.pop() {
        let entries = std::fs::read_dir(&folder).map_err(|error| format!("{}: {error}", folder.display()))?;
        for entry in entries {
            let path = entry.map_err(|error| error.to_string())?.path();
            if path.is_dir() {
                folders.push(path);
            } else if path.file_name() == Some(name.as_ref()) {
                found.push(path);
            }
        }
    }
    match found.len() {
        1 => Ok(found.remove(0)),
        0 => Err(format!("{name} is missing from {}", input.display())),
        _ => Err(format!("{name} appears more than once in {}", input.display())),
    }
}

fn decode(base64: &str, what: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.trim())
        .map_err(|error| format!("{what} is not base64: {error}"))?;
    String::from_utf8(bytes).map_err(|_| format!("{what} is not text"))
}

/// Checks a package the way the app will: the signature must verify against the trusted key
/// and name this version.
fn verify(key: &PublicKey, package: &[u8], signature: &str, version: &str, name: &str) -> Result<(), String> {
    let signature = Signature::decode(&decode(signature, &format!("The signature of {name}"))?)
        .map_err(|error| format!("The signature of {name} is invalid: {error}"))?;
    key.verify(package, &signature, true)
        .map_err(|error| format!("{name} was not signed by the updater key in tauri.conf.json: {error}"))?;
    let signed = signature
        .trusted_comment()
        .split('\t')
        .find_map(|field| field.strip_prefix("version:"));
    if signed != Some(version) {
        return Err(format!("{name} is signed for version {signed:?}, not {version}"));
    }
    Ok(())
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn trusted_key(root: &Path) -> Result<PublicKey, String> {
    let config = std::fs::read_to_string(root.join("src-tauri/tauri.conf.json")).map_err(|error| error.to_string())?;
    let config: Value = serde_json::from_str(&config).map_err(|error| error.to_string())?;
    let key = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .ok_or("tauri.conf.json has no updater public key")?;
    PublicKey::decode(&decode(key, "The updater public key")?)
        .map_err(|error| format!("The updater public key is invalid: {error}"))
}

/// The manifest and the files to publish under their published names.
fn assemble(key: &PublicKey, options: &Options, version: &str) -> Result<(Value, Vec<(String, PathBuf)>), String> {
    let base = format!("https://github.com/{}/releases/download/{}", options.repo, options.tag);
    let mut files = Vec::new();
    let mut platforms = serde_json::Map::new();
    for (arch, suffix, targets) in UPDATABLE {
        let name = package_name(version, arch, suffix);
        let package = find(&options.input, &name)?;
        let sig = find(&options.input, &format!("{name}.sig"))?;
        let signature = std::fs::read_to_string(&sig).map_err(|error| format!("{}: {error}", sig.display()))?;
        let bytes = std::fs::read(&package).map_err(|error| format!("{}: {error}", package.display()))?;
        verify(key, &bytes, &signature, version, &name)?;
        let published = published_name(&name);
        for target in targets {
            platforms.insert(
                (*target).to_owned(),
                json!({ "signature": signature.trim(), "url": format!("{base}/{published}") }),
            );
        }
        files.push((published.clone(), package));
        files.push((format!("{published}.sig"), sig));
    }
    for (arch, suffix) in DOWNLOADS {
        let name = package_name(version, arch, suffix);
        files.push((published_name(&name), find(&options.input, &name)?));
    }
    let mut manifest = json!({ "version": version, "platforms": platforms });
    if let Some(date) = &options.date {
        manifest["pub_date"] = json!(date);
    }
    Ok((manifest, files))
}

pub fn run(root: &Path, args: &[String]) -> Result<(), String> {
    let options = parse(args)?;
    if options.tag != format!("v{VERSION}") {
        return Err(format!(
            "The tag {} does not match the app version {VERSION} in Cargo.toml; tag v{VERSION} or change the version first.",
            options.tag
        ));
    }
    let parts: Vec<&str> = options.repo.split('/').collect();
    if parts.len() != 2
        || parts
            .iter()
            .any(|part| part.is_empty() || part.contains(char::is_whitespace))
    {
        return Err(format!("--repo must be owner/name, not {}", options.repo));
    }
    let key = trusted_key(root)?;
    let (manifest, files) = assemble(&key, &options, VERSION)?;
    std::fs::create_dir_all(&options.output).map_err(|error| error.to_string())?;
    let mut sums = String::new();
    for (name, source) in &files {
        let target = options.output.join(name);
        std::fs::copy(source, &target)
            .map_err(|error| format!("{} → {}: {error}", source.display(), target.display()))?;
        let bytes = std::fs::read(&target).map_err(|error| error.to_string())?;
        sums.push_str(&format!("{}  {name}\n", sha256(&bytes)));
    }
    let text = serde_json::to_string_pretty(&manifest).map_err(|error| error.to_string())?;
    std::fs::write(options.output.join("latest.json"), format!("{text}\n")).map_err(|error| error.to_string())?;
    std::fs::write(options.output.join("SHA256SUMS.txt"), sums).map_err(|error| error.to_string())?;
    println!(
        "{PRODUCT} {VERSION}: {} files, latest.json and SHA256SUMS.txt are in {}.",
        files.len(),
        options.output.display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Signed with a throwaway key made by `cargo tauri signer generate --ci` for these tests
    // only: `printf package > package && cargo tauri signer sign --app-version 9.9.9 package`.
    const TEST_KEY: &str = include_str!("../tests/fixtures/updater-test.pub");
    const OTHER_KEY: &str = include_str!("../tests/fixtures/other.pub");
    const SIGNATURE: &str = include_str!("../tests/fixtures/package.sig");

    fn key(base64: &str) -> PublicKey {
        PublicKey::decode(&decode(base64, "key").unwrap()).unwrap()
    }

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| (*arg).to_owned()).collect()
    }

    /// A release folder as the workflow downloads it: one folder per platform artifact.
    struct Fixture(PathBuf);

    impl Fixture {
        fn new(name: &str) -> Fixture {
            let folder = std::env::temp_dir().join(format!("tc-release-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&folder);
            for (index, (arch, suffix, _)) in UPDATABLE.iter().enumerate() {
                let platform = folder.join(format!("platform-{index}"));
                std::fs::create_dir_all(&platform).unwrap();
                let name = package_name("9.9.9", arch, suffix);
                std::fs::write(platform.join(&name), "package").unwrap();
                std::fs::write(platform.join(format!("{name}.sig")), SIGNATURE).unwrap();
            }
            for (arch, suffix) in DOWNLOADS {
                std::fs::write(folder.join(package_name("9.9.9", arch, suffix)), "download").unwrap();
            }
            Fixture(folder)
        }

        fn options(&self) -> Options {
            Options {
                tag: "v9.9.9".into(),
                repo: "o/r".into(),
                input: self.0.clone(),
                output: self.0.join("out"),
                date: Some("2026-11-11T00:00:00Z".into()),
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn options_require_the_tag_repository_and_folders() {
        let options = parse(&args(&[
            "--tag", "v1.2.3", "--repo", "o/r", "--input", "in", "--output", "out",
        ]))
        .unwrap();
        assert_eq!(options.tag, "v1.2.3");
        assert_eq!(options.date, None);
        assert!(parse(&args(&["--tag", "v1", "--repo", "o/r", "--input", "in"])).is_err());
        assert!(parse(&args(&["--tag"])).is_err());
        assert!(parse(&args(&["--version", "1"])).is_err());
    }

    #[test]
    fn published_names_have_no_spaces() {
        assert_eq!(
            published_name("Terminal Canvas_0.2.0_x64-setup.exe"),
            "Terminal-Canvas_0.2.0_x64-setup.exe"
        );
    }

    #[test]
    fn the_committed_updater_key_is_a_minisign_public_key() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        trusted_key(root).unwrap();
    }

    #[test]
    fn signatures_must_come_from_the_trusted_key_and_name_the_release_version() {
        verify(&key(TEST_KEY), b"package", SIGNATURE, "9.9.9", "package").unwrap();
        let error = verify(&key(TEST_KEY), b"package", SIGNATURE, "9.9.8", "package").unwrap_err();
        assert!(error.contains("not 9.9.8"), "{error}");
        let error = verify(&key(TEST_KEY), b"tampered", SIGNATURE, "9.9.9", "package").unwrap_err();
        assert!(error.contains("not signed by the updater key"), "{error}");
        let error = verify(&key(OTHER_KEY), b"package", SIGNATURE, "9.9.9", "package").unwrap_err();
        assert!(error.contains("not signed by the updater key"), "{error}");
        let error = verify(&key(TEST_KEY), b"package", "bm90IGEgc2lnbmF0dXJl", "9.9.9", "package").unwrap_err();
        assert!(error.contains("invalid"), "{error}");
    }

    #[test]
    fn a_release_needs_every_package_and_its_signature() {
        let fixture = Fixture::new("missing-image");
        std::fs::remove_file(fixture.0.join(package_name("9.9.9", "x64", ".dmg"))).unwrap();
        let error = assemble(&key(TEST_KEY), &fixture.options(), "9.9.9").unwrap_err();
        assert!(error.contains("_x64.dmg is missing"), "{error}");

        let fixture = Fixture::new("missing-signature");
        let name = package_name("9.9.9", "amd64", ".deb");
        std::fs::remove_file(fixture.0.join("platform-4").join(format!("{name}.sig"))).unwrap();
        let error = assemble(&key(TEST_KEY), &fixture.options(), "9.9.9").unwrap_err();
        assert!(error.contains(".deb.sig is missing"), "{error}");

        let fixture = Fixture::new("duplicate");
        std::fs::write(fixture.0.join(package_name("9.9.9", "x64", "-setup.exe")), "package").unwrap();
        let error = assemble(&key(TEST_KEY), &fixture.options(), "9.9.9").unwrap_err();
        assert!(error.contains("more than once"), "{error}");

        let fixture = Fixture::new("wrong-key");
        let error = assemble(&key(OTHER_KEY), &fixture.options(), "9.9.9").unwrap_err();
        assert!(error.contains("not signed by the updater key"), "{error}");
    }

    #[test]
    fn the_manifest_points_every_target_at_its_published_package() {
        let fixture = Fixture::new("manifest");
        let (manifest, files) = assemble(&key(TEST_KEY), &fixture.options(), "9.9.9").unwrap();
        // The app's side of this contract is checked against the same file in src-tauri.
        let expected: Value = serde_json::from_str(include_str!("../tests/fixtures/latest.json")).unwrap();
        assert_eq!(manifest, expected);
        assert_eq!(files.len(), UPDATABLE.len() * 2 + DOWNLOADS.len());
        assert!(files.iter().all(|(name, _)| !name.contains(' ')));
        assert!(
            files
                .iter()
                .any(|(name, _)| name == "Terminal-Canvas_9.9.9_x64_portable.zip")
        );
    }

    #[test]
    fn publishing_checks_the_tag_and_repository_first() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let wrong_tag = args(&[
            "--tag",
            "v0.0.0-wrong",
            "--repo",
            "o/r",
            "--input",
            "in",
            "--output",
            "out",
        ]);
        let error = run(root, &wrong_tag).unwrap_err();
        assert!(error.contains("does not match the app version"), "{error}");
        let tag = format!("v{VERSION}");
        let bad_repo = args(&["--tag", &tag, "--repo", "o/r/x", "--input", "in", "--output", "out"]);
        assert!(run(root, &bad_repo).unwrap_err().contains("owner/name"));
    }
}
