//! Test-only profile isolation and diagnostics. None of this module is compiled in normal builds.
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tauri::{Manager, State, Webview};
use tc_pty::manager::{Backend, EventSink, Process, SessionKey, SpawnRequest};

use crate::host::Host;

/// Elevated WebView2 hosts ignore environment-based switch overrides. Supply the
/// test process's arguments through the API while keeping pinned Wry's defaults.
#[cfg(any(windows, test))]
pub fn browser_arguments(additional: Option<&str>) -> Option<String> {
    additional.filter(|value| !value.trim().is_empty()).map(|value| {
        format!(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required {value}"
        )
    })
}

// User PowerShell profiles can rebuild PATH after the harness prepends its controlled tools.
// Test shells skip those profiles, so an automatic resume can never fall through to a real CLI.
pub struct TestBackend(pub tc_pty::PtyBackend);

fn isolated_request(request: &SpawnRequest) -> SpawnRequest {
    let mut isolated = request.clone();
    let shell = request
        .shell
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(shell.as_str(), "powershell" | "powershell.exe" | "pwsh" | "pwsh.exe")
        && !isolated.args.iter().any(|arg| arg.eq_ignore_ascii_case("-NoProfile"))
    {
        isolated.args.insert(0, "-NoProfile".into());
    }
    isolated
}

impl Backend for TestBackend {
    fn spawn(
        &mut self,
        request: &SpawnRequest,
        key: SessionKey,
        events: EventSink,
    ) -> std::io::Result<Box<dyn Process>> {
        self.0.spawn(&isolated_request(request), key, events)
    }

    fn watch_directory(
        &mut self,
        pid: u32,
        platform: tc_core::Platform,
        key: SessionKey,
        events: EventSink,
    ) -> Box<dyn Send> {
        self.0.watch_directory(pid, platform, key, events)
    }
}

pub struct TestRun {
    pub profile: PathBuf,
    pub links: Mutex<Vec<String>>,
    pub choices: Mutex<VecDeque<Option<PathBuf>>>,
    pub dialogs: Mutex<Vec<Value>>,
}

impl TestRun {
    pub fn from_args(args: impl IntoIterator<Item = String>) -> Result<Self, String> {
        let mut profile = None;
        for arg in args {
            let name = if arg == "--smoke-test" {
                Some("tauri-smoke-profile")
            } else if let Some(phase) = arg.strip_prefix("--restoration-smoke=") {
                if !matches!(phase, "save" | "reopen") {
                    return Err("Restoration phase must be save or reopen.".into());
                }
                Some("tauri-restoration-profile")
            } else {
                None
            };
            if let Some(name) = name {
                if profile.is_some() {
                    return Err("Choose one test profile flag.".into());
                }
                profile = Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.cache").join(name));
            }
        }
        // A test build must never fall back to the user's real workspace, even when launched
        // through a native app bundle that supplies no command-line arguments.
        let profile =
            profile.unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.cache/tauri-smoke-profile"));
        Ok(Self {
            profile,
            links: Mutex::new(Vec::new()),
            choices: Mutex::new(VecDeque::new()),
            dialogs: Mutex::new(Vec::new()),
        })
    }
}

#[tauri::command]
pub async fn e2e_state(webview: Webview, host: State<'_, Arc<Host>>, run: State<'_, TestRun>) -> Result<Value, String> {
    crate::authorized(&webview)?;
    Ok(json!({
        "host": host.diagnostics().await,
        "profile": run.profile,
        "links": *run.links.lock().unwrap(),
        "dialogs": *run.dialogs.lock().unwrap(),
    }))
}

#[tauri::command]
pub fn e2e_dialog(webview: Webview, run: State<'_, TestRun>, path: Option<PathBuf>) -> Result<(), String> {
    crate::authorized(&webview)?;
    run.choices.lock().unwrap().push_back(path);
    Ok(())
}

#[tauri::command]
pub fn e2e_request_close(webview: Webview, _run: State<'_, TestRun>) -> Result<(), String> {
    crate::authorized(&webview)?;
    webview
        .app_handle()
        .get_webview_window("main")
        .ok_or("The main window is unavailable.")?
        .close()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn e2e_focus(webview: Webview, _run: State<'_, TestRun>) -> Result<(), String> {
    crate::authorized(&webview)?;
    let window = webview
        .app_handle()
        .get_webview_window("main")
        .ok_or("The main window is unavailable.")?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_test_browser_arguments_keep_the_production_wry_defaults() {
        assert_eq!(browser_arguments(None), None);
        assert_eq!(browser_arguments(Some("  ")), None);
        let arguments =
            browser_arguments(Some("--remote-debugging-port=9234 --force-device-scale-factor=1.25")).unwrap();
        assert!(arguments.starts_with("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection "));
        assert!(arguments.contains("--autoplay-policy=no-user-gesture-required"));
        assert!(arguments.ends_with("--remote-debugging-port=9234 --force-device-scale-factor=1.25"));
    }

    #[test]
    fn powershell_test_shells_cannot_replace_the_controlled_tool_path_from_a_profile() {
        for shell in [
            "powershell.exe",
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            "pwsh",
            "PWSH.EXE",
            "cmd.exe",
            "/bin/bash",
        ] {
            let request = SpawnRequest {
                shell: shell.into(),
                args: vec!["-NoExit".into()],
                cwd: "/test".into(),
                cols: 80,
                rows: 24,
                env: [("Path".into(), "controlled-tools;system-tools".into())].into(),
            };
            let isolated = isolated_request(&request);
            assert_eq!(isolated.env, request.env);
            assert_eq!(isolated.cwd, request.cwd);
            let powershell =
                shell.to_ascii_lowercase().contains("powershell") || shell.to_ascii_lowercase().contains("pwsh");
            assert_eq!(
                isolated.args.first().unwrap(),
                if powershell { "-NoProfile" } else { "-NoExit" }
            );
        }
    }
    #[test]
    fn flags_use_only_isolated_profiles_and_restoration_phases_share_one() {
        let run = |args: &[&str]| TestRun::from_args(args.iter().map(|arg| (*arg).to_owned()));
        assert!(run(&[]).unwrap().profile.ends_with(".cache/tauri-smoke-profile"));
        let smoke = run(&["--smoke-test"]).unwrap();
        let save = run(&["--restoration-smoke=save"]).unwrap();
        let reopen = run(&["--restoration-smoke=reopen"]).unwrap();
        assert_ne!(smoke.profile, save.profile);
        assert_eq!(save.profile, reopen.profile);
        assert!(smoke.profile.ends_with(".cache/tauri-smoke-profile"));
        assert!(run(&["--restoration-smoke=unknown"]).is_err());
        assert!(run(&["--smoke-test", "--restoration-smoke=save"]).is_err());
    }
}
