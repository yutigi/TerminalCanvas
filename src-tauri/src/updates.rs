//! Automatic updates from the project's GitHub releases.
//!
//! A release build reads `latest.json` from the latest published GitHub release shortly after
//! startup, and again every few hours until it finds an update. The publish workflow signs every
//! package, and the updater accepts only packages signed by the key in `tauri.conf.json` for the
//! version the manifest names.
//!
//! An installed copy (the Windows NSIS install, a macOS `.app` bundle, a Linux AppImage or Debian
//! package) downloads and verifies the update in the background, then the UI offers to restart.
//! Restarting goes through the normal close handshake, so the workspace is saved and every
//! terminal is stopped first. Copies that cannot be replaced in place, such as the portable
//! Windows zip, only link to the release page.
//!
//! Development, test, and E2E builds never contact the network.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tauri::utils::config::BundleType;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};
use tc_core::Platform as Os;

use crate::host::Host;

/// Release pages; the updater endpoint itself is in `tauri.conf.json`.
pub const RELEASES: &str = "https://github.com/yutigi/TerminalCanvas/releases";
/// Set to any value to turn off update checks.
pub const DISABLE_VARIABLE: &str = "TERMINAL_CANVAS_DISABLE_UPDATES";
/// The first check waits until startup work is done.
const FIRST_CHECK: Duration = Duration::from_secs(20);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// How this copy of the app was installed, which decides whether an update can replace it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Package {
    /// The per-user NSIS install on Windows.
    WindowsInstaller,
    /// An `.app` bundle on macOS.
    MacBundle,
    /// A Linux AppImage.
    AppImage,
    /// The Linux Debian package. Installing asks for an administrator password.
    Debian,
    /// The portable Windows zip, a binary run from `target/`, or a package format we don't ship.
    Unpackaged,
}

impl Package {
    /// Identifies the running copy. `bundle` is the type the bundler recorded in the binary;
    /// copies outside a bundle (like the portable zip) have none.
    pub fn detect(os: Os, bundle: Option<BundleType>, exe: Option<&Path>, appimage: bool) -> Package {
        match (os, bundle) {
            (Os::Windows, Some(BundleType::Nsis)) => Package::WindowsInstaller,
            // macOS binaries are never patched, so only the location identifies a bundle.
            (Os::MacOs, _) if exe.is_some_and(|exe| in_app_bundle(exe) && !translocated(exe)) => Package::MacBundle,
            (Os::Linux, Some(BundleType::AppImage)) if appimage => Package::AppImage,
            (Os::Linux, Some(BundleType::Deb)) => Package::Debian,
            _ => Package::Unpackaged,
        }
    }

    fn current(app: &AppHandle) -> Package {
        #[cfg(target_os = "linux")]
        let appimage = app.env().appimage.is_some();
        #[cfg(not(target_os = "linux"))]
        let appimage = {
            let _ = app;
            false
        };
        let exe = std::env::current_exe().ok();
        Package::detect(
            Os::current(),
            tauri::utils::platform::bundle_type(),
            exe.as_deref(),
            appimage,
        )
    }
}

/// `…/Name.app/Contents/MacOS/binary`
fn in_app_bundle(exe: &Path) -> bool {
    let folders: Vec<&Path> = exe.ancestors().skip(1).take(3).collect();
    matches!(folders.as_slice(), [macos, contents, app]
        if macos.file_name() == Some("MacOS".as_ref())
            && contents.file_name() == Some("Contents".as_ref())
            && app.extension() == Some("app".as_ref()))
}

/// Gatekeeper runs a quarantined app that was never moved (for example, opened straight from the
/// downloaded disk image) from a read-only copy, which an update can't replace.
fn translocated(exe: &Path) -> bool {
    exe.components().any(|part| part.as_os_str() == "AppTranslocation")
}

/// What the app does about updates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// No checks: development and test builds, or turned off with [`DISABLE_VARIABLE`].
    Off,
    /// Download the update and replace this copy.
    Install,
    /// Link to the release; this copy can't be replaced in place.
    Notify,
}

impl Mode {
    pub fn choose(release_build: bool, disabled: bool, package: Package) -> Mode {
        if !release_build || disabled {
            Mode::Off
        } else if package == Package::Unpackaged {
            Mode::Notify
        } else {
            Mode::Install
        }
    }

    fn current(app: &AppHandle) -> Mode {
        let release_build = !cfg!(debug_assertions) && !cfg!(feature = "e2e");
        let disabled = std::env::var_os(DISABLE_VARIABLE).is_some();
        Mode::choose(release_build, disabled, Package::current(app))
    }
}

/// An update the UI offers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Offer {
    pub version: String,
    pub notes: Option<String>,
    /// The release page.
    pub url: String,
    /// Whether the downloaded update can replace this copy, or the UI only links to it.
    pub installable: bool,
}

impl Offer {
    fn new(version: &str, notes: Option<String>, mode: Mode) -> Offer {
        Offer {
            version: version.to_owned(),
            notes: notes.filter(|notes| !notes.trim().is_empty()),
            url: release_page(version),
            installable: mode == Mode::Install,
        }
    }
}

/// Releases are tagged `v<version>`.
pub fn release_page(version: &str) -> String {
    format!("{RELEASES}/tag/v{version}")
}

/// The renderer's `update` event: the running version and the update on offer, if any.
pub fn event(current: &str, offer: Option<&Offer>) -> Value {
    json!({
        "type": "update",
        "current": current,
        "update": offer.map(|offer| json!({
            "version": offer.version,
            "notes": offer.notes,
            "url": offer.url,
            "installable": offer.installable,
        })),
    })
}

/// A verified update package.
type Downloaded = (Update, Arc<[u8]>);

pub struct Updates {
    mode: Mode,
    current: String,
    offer: Mutex<Option<Offer>>,
    /// The verified package, kept until it is installed.
    package: Mutex<Option<Downloaded>>,
    /// Restart into the update when the app exits. On Windows the installer runs at exit.
    armed: AtomicBool,
}

fn text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

impl Updates {
    pub fn new(app: &AppHandle) -> Arc<Updates> {
        Arc::new(Updates {
            mode: Mode::current(app),
            current: app.package_info().version.to_string(),
            offer: Mutex::new(None),
            package: Mutex::new(None),
            armed: AtomicBool::new(false),
        })
    }

    pub fn event(&self) -> Value {
        event(
            &self.current,
            self.offer.lock().unwrap_or_else(|e| e.into_inner()).as_ref(),
        )
    }

    fn package(&self) -> Option<Downloaded> {
        self.package.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn armed(&self) -> bool {
        self.armed.load(Ordering::SeqCst)
    }

    /// Checks in the background until an update is found, then tells the renderer.
    pub fn start(self: &Arc<Self>, app: AppHandle, host: Arc<Host>) {
        if self.mode == Mode::Off {
            return;
        }
        let updates = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(FIRST_CHECK).await;
            loop {
                match updates.check(&app).await {
                    Ok(true) => {
                        host.emit(updates.event());
                        break;
                    }
                    Ok(false) => {}
                    // Offline, rate-limited, or no release with a manifest yet: try again later.
                    Err(error) => eprintln!("Could not check for updates: {error}"),
                }
                tokio::time::sleep(CHECK_INTERVAL).await;
            }
        });
    }

    /// Whether an update was found. An installable update is downloaded and verified first.
    async fn check(&self, app: &AppHandle) -> Result<bool, String> {
        let updater = app.updater_builder().timeout(CHECK_TIMEOUT).build().map_err(text)?;
        let Some(mut update) = updater.check().await.map_err(text)? else {
            return Ok(false);
        };
        if self.mode == Mode::Install {
            update.timeout = Some(DOWNLOAD_TIMEOUT);
            // `download` verifies the signature and the signed version before returning.
            let bytes = update.download(|_, _| {}, || {}).await.map_err(text)?;
            *self.package.lock().unwrap_or_else(|e| e.into_inner()) = Some((update.clone(), Arc::from(bytes)));
        }
        *self.offer.lock().unwrap_or_else(|e| e.into_inner()) =
            Some(Offer::new(&update.version, update.body, self.mode));
        Ok(true)
    }

    /// The renderer's `update-install`, after the user agreed to restart. The renderer closes
    /// the app next; [`exit`] then restarts into the update.
    ///
    /// macOS and Linux replace the app on disk now, so a failure is reported while the app is
    /// still open. The running copy keeps working until the restart. Windows can't replace the
    /// running executable, so its installer starts at exit.
    pub async fn install(&self) -> Result<Value, String> {
        if self.armed() {
            return Ok(json!({ "ok": true }));
        }
        let (update, bytes) = self.package().ok_or("No downloaded update is ready to install.")?;
        if !cfg!(windows) {
            tauri::async_runtime::spawn_blocking(move || update.install(&bytes))
                .await
                .map_err(text)?
                .map_err(|error| format!("Could not install the update: {error}"))?;
        }
        self.armed.store(true, Ordering::SeqCst);
        Ok(json!({ "ok": true }))
    }
}

/// Finishes app exit once the host has saved and stopped everything, restarting into an update
/// the user accepted. Windows restarts from the installer [`apply_at_exit`] starts.
pub fn exit(app: &AppHandle) {
    let armed = app.try_state::<Arc<Updates>>().is_some_and(|updates| updates.armed());
    if armed && !cfg!(windows) {
        app.request_restart();
    } else {
        app.exit(0);
    }
}

/// `RunEvent::Exit`: on Windows, starts the installer of an accepted update. The installer
/// replaces the app once this process ends, then starts it again.
pub fn apply_at_exit(app: &AppHandle) {
    if !cfg!(windows) {
        return;
    }
    let Some(updates) = app.try_state::<Arc<Updates>>() else {
        return;
    };
    if !updates.armed() {
        return;
    }
    if let Some((update, bytes)) = updates.package() {
        // Exits the process once the installer has started.
        if let Err(error) = update.install(&bytes) {
            eprintln!("Could not start the update installer: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn only_bundled_copies_install_updates() {
        let bundle_exe = PathBuf::from("/Applications/Terminal Canvas.app/Contents/MacOS/terminal-canvas");
        let translocated_exe = PathBuf::from(
            "/private/var/folders/x/T/AppTranslocation/1234/d/Terminal Canvas.app/Contents/MacOS/terminal-canvas",
        );
        let target_exe = PathBuf::from("/work/target/release/terminal-canvas");
        let cases = [
            (
                Os::Windows,
                Some(BundleType::Nsis),
                None,
                false,
                Package::WindowsInstaller,
            ),
            // The portable zip carries the binary from before the bundler patched it.
            (Os::Windows, None, None, false, Package::Unpackaged),
            (Os::Windows, Some(BundleType::Msi), None, false, Package::Unpackaged),
            (Os::MacOs, None, Some(&bundle_exe), false, Package::MacBundle),
            (Os::MacOs, None, Some(&target_exe), false, Package::Unpackaged),
            (Os::MacOs, None, Some(&translocated_exe), false, Package::Unpackaged),
            (Os::Linux, Some(BundleType::AppImage), None, true, Package::AppImage),
            // A binary extracted from an AppImage can't replace the AppImage.
            (Os::Linux, Some(BundleType::AppImage), None, false, Package::Unpackaged),
            (Os::Linux, Some(BundleType::Deb), None, false, Package::Debian),
            (Os::Linux, Some(BundleType::Rpm), None, false, Package::Unpackaged),
            (Os::Linux, None, None, false, Package::Unpackaged),
        ];
        for (os, bundle, exe, appimage, expected) in cases {
            assert_eq!(
                Package::detect(os, bundle.clone(), exe.map(PathBuf::as_path), appimage),
                expected,
                "{os:?} {bundle:?} {exe:?}"
            );
        }
    }

    #[test]
    fn app_bundles_are_recognized_by_their_layout() {
        assert!(in_app_bundle(Path::new(
            "/A/Terminal Canvas.app/Contents/MacOS/Terminal Canvas"
        )));
        assert!(!in_app_bundle(Path::new(
            "/A/Terminal Canvas/Contents/MacOS/Terminal Canvas"
        )));
        assert!(!in_app_bundle(Path::new(
            "/A/Terminal Canvas.app/MacOS/Terminal Canvas"
        )));
        assert!(!in_app_bundle(Path::new("terminal-canvas")));
    }

    #[test]
    fn development_builds_and_opted_out_users_never_check() {
        assert_eq!(Mode::choose(false, false, Package::WindowsInstaller), Mode::Off);
        assert_eq!(Mode::choose(true, true, Package::MacBundle), Mode::Off);
        assert_eq!(Mode::choose(true, false, Package::AppImage), Mode::Install);
        assert_eq!(Mode::choose(true, false, Package::Debian), Mode::Install);
        assert_eq!(Mode::choose(true, false, Package::Unpackaged), Mode::Notify);
    }

    #[test]
    fn the_event_names_the_running_version_and_the_offer() {
        assert_eq!(
            event("0.1.0", None),
            json!({ "type": "update", "current": "0.1.0", "update": null })
        );
        let offer = Offer::new("0.2.0", Some("  ".into()), Mode::Notify);
        assert_eq!(
            event("0.1.0", Some(&offer)),
            json!({
                "type": "update",
                "current": "0.1.0",
                "update": {
                    "version": "0.2.0",
                    "notes": null,
                    "url": "https://github.com/yutigi/TerminalCanvas/releases/tag/v0.2.0",
                    "installable": false,
                },
            })
        );
        let offer = Offer::new("0.2.0", Some("Fixes".into()), Mode::Install);
        assert_eq!(event("0.1.0", Some(&offer))["update"]["installable"], true);
        assert_eq!(event("0.1.0", Some(&offer))["update"]["notes"], "Fixes");
    }

    #[test]
    fn the_configuration_checks_signed_releases_over_https() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater: tauri_plugin_updater::Config =
            serde_json::from_value(config["plugins"]["updater"].clone()).unwrap();
        assert!(updater.require_signed_version);
        assert!(!updater.allow_downgrades);
        assert!(!updater.dangerous_insecure_transport_protocol);
        assert_eq!(
            updater.endpoints.iter().map(|url| url.as_str()).collect::<Vec<_>>(),
            [format!("{RELEASES}/latest/download/latest.json")]
        );
        // A minisign public key, base64-encoded with its comment line.
        use base64::Engine;
        let key = base64::engine::general_purpose::STANDARD
            .decode(&updater.pubkey)
            .expect("base64 public key");
        let key = String::from_utf8(key).unwrap();
        assert!(key.starts_with("untrusted comment: minisign public key"), "{key}");
        // The version comes from Cargo.toml, so a release tag needs one change.
        assert!(config.get("version").is_none());
    }

    #[test]
    fn the_app_reads_the_manifest_the_release_task_writes() {
        // `cargo xtask release` must produce exactly this file for the same inputs.
        let release: tauri_plugin_updater::RemoteRelease =
            serde_json::from_str(include_str!("../../xtask/tests/fixtures/latest.json")).unwrap();
        assert_eq!(release.version.to_string(), "9.9.9");
        assert!(release.pub_date.is_some());
        // Bundled copies look up `<os>-<arch>-<bundle type>`; the others `<os>-<arch>`.
        for target in [
            "windows-x86_64-nsis",
            "windows-x86_64",
            "darwin-aarch64-app",
            "darwin-x86_64-app",
            "linux-x86_64-appimage",
            "linux-x86_64-deb",
            "linux-x86_64",
        ] {
            let url = release.download_url(target).unwrap();
            assert!(
                url.as_str()
                    .starts_with("https://github.com/o/r/releases/download/v9.9.9/")
            );
            assert!(!release.signature(target).unwrap().is_empty());
        }
    }
}
