//! Per-terminal shell integration files, from `prepareIntegration` in `src/shell-integration.cjs`.
//!
//! Ordinary CLI launches are intercepted without changing global CLI settings: each terminal gets
//! its own script, Claude settings file, and session file, all removed when the terminal ends.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use tc_core::Platform;

use crate::shell::{bash_source, claude_settings, powershell_args, powershell_source, sh_quote};

/// Names `tc-hook`.
pub const HOOK_ENV: &str = "TC_HOOK";
/// Names the file the session-start hooks record a terminal's AI session in.
pub const SESSION_ENV: &str = "TC_SESSION_FILE";
/// Identifies one AI launch from an integrated terminal; the integration scripts set it.
pub const TOKEN_ENV: &str = "TC_LAUNCH_TOKEN";
/// Every variable a terminal's integration sets. They name one terminal's files, so a terminal never
/// inherits them from the app, which may itself run in a Terminal Canvas terminal.
pub const ENV_KEYS: [&str; 4] = [HOOK_ENV, SESSION_ENV, TOKEN_ENV, tc_core::launch::ENV];

/// What a terminal needs to load the integration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Integration {
    /// Shell arguments, when the integration replaces them (PowerShell and Bash).
    pub args: Option<Vec<String>>,
    /// A command to type first, after login profiles have run (Bash).
    pub command: Option<String>,
    /// Where `tc-hook record <provider>` writes the session its SessionStart hook reported.
    pub session_file: PathBuf,
    /// The private folder `tc-hook new-terminal` writes launch requests to, named by
    /// `TC_LAUNCH_DIR` (see [`tc_core::launch`]).
    pub launch_dir: Option<PathBuf>,
    pub env: Vec<(String, String)>,
    files: Vec<PathBuf>,
}

impl Integration {
    /// An integration whose only file is `session_file`, for tests and other backends.
    pub fn new(
        args: Option<Vec<String>>,
        command: Option<String>,
        session_file: PathBuf,
        env: Vec<(String, String)>,
    ) -> Self {
        Integration {
            args,
            command,
            session_file,
            launch_dir: None,
            env,
            files: Vec::new(),
        }
    }

    /// Accepts launch requests from `folder`, which the caller has created.
    #[must_use]
    pub fn with_launch_dir(mut self, folder: PathBuf) -> Self {
        self.launch_dir = Some(folder);
        self
    }

    /// Removes the integration's files and any requests it never handled. Missing files are fine.
    pub fn cleanup(&self) {
        for file in self.files.iter().chain([&self.session_file]) {
            let _ = fs::remove_file(file);
        }
        if let Some(folder) = &self.launch_dir {
            let _ = fs::remove_dir_all(folder);
        }
    }
}

/// The final path component, split on `/` and `\` like `path.win32.basename`.
fn windows_basename(shell: &str) -> &str {
    shell.rsplit(['/', '\\']).next().unwrap_or(shell)
}

/// Whether `shell` is cmd, which uses its native `PROMPT` reports; PowerShell functions cannot run there.
pub fn is_cmd(shell: &str) -> bool {
    let name = windows_basename(shell).to_ascii_lowercase();
    name == "cmd" || name == "cmd.exe"
}

/// Writes the integration files for one terminal in `folder`. `hook` is the `tc-hook` executable.
/// Every terminal gets a launch request inbox (see [`tc_core::launch`]). cmd runs no integration
/// script, so it gets only the inbox and `TC_HOOK`.
pub fn prepare(folder: &Path, hook: &Path, platform: Platform, shell: &str) -> io::Result<Option<Integration>> {
    let windows = platform.is_windows();
    let launch_dir = tc_core::launch::terminal_inbox();
    let launch_env = (
        tc_core::launch::ENV.to_owned(),
        launch_dir.to_string_lossy().into_owned(),
    );
    if windows && is_cmd(shell) {
        tc_core::launch::create_inbox(&launch_dir, true).map_err(at(&launch_dir))?;
        return Ok(Some(Integration {
            args: None,
            command: None,
            // Never written: cmd has no AI launch wrappers.
            session_file: folder.join(format!("{}.json", uuid::Uuid::new_v4())),
            launch_dir: Some(launch_dir),
            env: vec![(HOOK_ENV.to_owned(), hook.to_string_lossy().into_owned()), launch_env],
            files: Vec::new(),
        }));
    }
    create_private_dir(folder).map_err(at(folder))?;
    let stem = folder.join(uuid::Uuid::new_v4().to_string());
    let with_suffix = |suffix: &str| {
        let mut path = stem.clone().into_os_string();
        path.push(suffix);
        PathBuf::from(path)
    };
    let session_file = with_suffix(".json");
    let settings = with_suffix(".settings.json");
    let hook = hook.to_string_lossy();
    let settings_text = settings.to_string_lossy();
    let source = if windows {
        powershell_source(&settings_text)
    } else {
        bash_source(&settings_text)
    };
    let script = with_suffix(if windows { ".ps1" } else { ".bash" });
    let files = vec![settings.clone(), script.clone()];
    write_all_private(&[
        (&settings, claude_settings(&hook, windows).as_bytes()),
        (&script, source.as_bytes()),
    ])?;
    let (args, command) = if windows {
        (Some(powershell_args(&source)), None)
    } else if Path::new(shell).file_name().is_some_and(|name| name == "bash") {
        // Login profiles keep control of environment setup and whether .bashrc is sourced, so the
        // integration is queued as the first input command, after Bash finishes those profiles.
        let args = vec!["--login".to_owned(), "-i".to_owned()];
        (
            Some(args),
            Some(format!("source {}", sh_quote(&script.to_string_lossy()))),
        )
    } else {
        (None, None)
    };
    if let Err(error) = tc_core::launch::create_inbox(&launch_dir, true) {
        for file in &files {
            let _ = fs::remove_file(file);
        }
        return Err(at(&launch_dir)(error));
    }
    let env = vec![
        (SESSION_ENV.to_owned(), session_file.to_string_lossy().into_owned()),
        (HOOK_ENV.to_owned(), hook.into_owned()),
        launch_env,
    ];
    Ok(Some(Integration {
        args,
        command,
        session_file,
        launch_dir: Some(launch_dir),
        env,
        files,
    }))
}

/// Names `path` in an error, so a failed setup says which file or folder to fix.
fn at(path: &Path) -> impl FnOnce(io::Error) -> io::Error + '_ {
    move |error| io::Error::new(error.kind(), format!("{}: {error}", path.display()))
}

fn create_private_dir(folder: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(folder)
}

/// Writes each file, owner-only. If any write fails, every file is removed, including one written
/// part-way, and the error names the file: a terminal then starts without integration, and repeated
/// starts must not pile up broken files.
fn write_all_private(files: &[(&Path, &[u8])]) -> io::Result<()> {
    for (index, (path, bytes)) in files.iter().enumerate() {
        if let Err(error) = write_private(path, bytes) {
            for (written, _) in &files[..=index] {
                let _ = fs::remove_file(written);
            }
            return Err(at(path)(error));
        }
    }
    Ok(())
}

fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cmd_detection_uses_the_windows_basename() {
        for shell in [
            "cmd",
            "cmd.exe",
            "CMD.EXE",
            "C:\\Windows\\System32\\cmd.exe",
            "C:/Windows/cmd",
        ] {
            assert!(is_cmd(shell), "{shell}");
        }
        for shell in ["powershell.exe", "cmdx.exe", "C:\\cmd\\pwsh.exe"] {
            assert!(!is_cmd(shell), "{shell}");
        }
    }

    #[test]
    fn a_failed_write_leaves_no_integration_files() {
        let folder = std::env::temp_dir().join(format!("tc-integration-{}", uuid::Uuid::new_v4()));
        let blocked = folder.join("blocked.ps1");
        fs::create_dir_all(&blocked).unwrap();
        let settings = folder.join("a.settings.json");
        let error = write_all_private(&[(&settings, b"{}"), (&blocked, b"script")]).unwrap_err();
        assert!(error.to_string().starts_with(&blocked.display().to_string()), "{error}");
        assert!(!settings.exists(), "the file written before the failure is removed");
        assert!(blocked.is_dir(), "a folder in the way is never removed");
        write_all_private(&[(&settings, b"{}")]).unwrap();
        assert_eq!(fs::read_to_string(&settings).unwrap(), "{}");
        fs::remove_dir_all(folder).unwrap();
    }
}
