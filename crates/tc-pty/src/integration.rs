//! Per-terminal shell integration files, from `prepareIntegration` in `src/shell-integration.cjs`.
//!
//! Ordinary CLI launches are intercepted without changing global CLI settings: each terminal gets
//! its own script, Claude settings file, and session file, all removed when the terminal ends.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use tc_core::Platform;

use crate::shell::{bash_source, claude_settings, powershell_args, powershell_source, sh_quote};

/// What a terminal needs to load the integration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Integration {
    /// Shell arguments, when the integration replaces them (PowerShell and Bash).
    pub args: Option<Vec<String>>,
    /// A command to type first, after login profiles have run (Bash).
    pub command: Option<String>,
    /// Where `tc-hook record claude` writes the session the Claude hook reported.
    pub session_file: PathBuf,
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
            env,
            files: Vec::new(),
        }
    }

    /// Removes the integration's files. Missing files are fine.
    pub fn cleanup(&self) {
        for file in self.files.iter().chain([&self.session_file]) {
            let _ = fs::remove_file(file);
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
/// Returns `None` for cmd.
pub fn prepare(folder: &Path, hook: &Path, platform: Platform, shell: &str) -> io::Result<Option<Integration>> {
    let windows = platform.is_windows();
    if windows && is_cmd(shell) {
        return Ok(None);
    }
    create_private_dir(folder)?;
    let stem = folder.join(uuid::Uuid::new_v4().to_string());
    let with_suffix = |suffix: &str| {
        let mut path = stem.clone().into_os_string();
        path.push(suffix);
        PathBuf::from(path)
    };
    let session_file = with_suffix(".json");
    let settings = with_suffix(".settings.json");
    let hook = hook.to_string_lossy();
    write_private(&settings, claude_settings(&hook, windows).as_bytes())?;
    let settings_text = settings.to_string_lossy();
    let source = if windows {
        powershell_source(&settings_text)
    } else {
        bash_source(&settings_text)
    };
    let script = with_suffix(if windows { ".ps1" } else { ".bash" });
    let files = vec![settings.clone(), script.clone()];
    if let Err(error) = write_private(&script, source.as_bytes()) {
        let _ = fs::remove_file(&settings);
        return Err(error);
    }
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
    let env = vec![
        (
            "TC_SESSION_FILE".to_owned(),
            session_file.to_string_lossy().into_owned(),
        ),
        ("TC_HOOK".to_owned(), hook.into_owned()),
    ];
    Ok(Some(Integration {
        args,
        command,
        session_file,
        env,
        files,
    }))
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
}
