//! The app's tmux setup: whether tmux is usable here, and one command that installs it.
//!
//! The command runs in a terminal on the canvas, so the user sees its progress and answers any
//! UAC, sudo, or package-manager prompt themselves. Nothing here installs anything.

use std::path::{Path, PathBuf};

use crate::client::{MSYS2_BIN, Version, find_binary};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Windows,
    MacOs,
    Linux,
}

impl Os {
    pub fn current() -> Option<Self> {
        if cfg!(windows) {
            Some(Self::Windows)
        } else if cfg!(target_os = "macos") {
            Some(Self::MacOs)
        } else if cfg!(target_os = "linux") {
            Some(Self::Linux)
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installed {
    pub binary: PathBuf,
    /// `None` when `tmux -V` failed or printed something unrecognized.
    pub version: Option<Version>,
}

impl Installed {
    /// Present and new enough for per-window control-client sizing.
    pub fn usable(&self) -> bool {
        self.version.is_some_and(Version::supported)
    }
}

/// The tmux this machine would use, if any. Runs `tmux -V`, so callers keep it off async threads.
pub fn installed() -> Option<Installed> {
    let binary = find_binary(None).ok()?;
    let version = Version::read(&binary).ok();
    Some(Installed { binary, version })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    /// The tool that installs tmux, as shown to the user.
    pub manager: &'static str,
    /// One line for the platform's terminal shell: Windows PowerShell on Windows; on macOS and
    /// Linux, any of sh, bash, zsh, or fish.
    pub command: String,
}

/// MSYS2 itself, from winget's community source, before its tmux.
const WINGET_MSYS2: &str =
    "winget install --id MSYS2.MSYS2 -e --source winget --accept-source-agreements --accept-package-agreements";
/// tmux, plus `script`, which the Windows control client runs tmux under (see `client`).
const PACMAN_TMUX: &str = "pacman -Sy --noconfirm --needed tmux util-linux";
/// Linux package managers, most common first, each with the arguments that install tmux.
const LINUX: [(&str, &str); 5] = [
    ("apt-get", "apt-get update && apt-get install -y tmux"),
    ("dnf", "dnf install -y tmux"),
    ("pacman", "pacman -S --needed --noconfirm tmux"),
    ("zypper", "zypper --non-interactive install tmux"),
    ("apk", "apk add tmux"),
];

/// How to install tmux on `os`, given `find`, which locates a program as [`crate::client::find_program`]
/// does. `None` when this machine has no supported package manager.
pub fn plan(os: Os, find: impl Fn(&str) -> Option<PathBuf>) -> Option<Plan> {
    match os {
        Os::Windows => {
            // pacman, not bash: Git for Windows puts its own bash on PATH, but no pacman.
            if let Some(tools) = find("pacman").as_deref().and_then(Path::parent) {
                return Some(Plan {
                    manager: "MSYS2",
                    command: msys2_bash(tools),
                });
            }
            find("winget")?;
            let tools = Path::new(MSYS2_BIN);
            Some(Plan {
                manager: "winget and MSYS2",
                command: format!(
                    "{WINGET_MSYS2}; if (Test-Path {}) {{ {} }}",
                    ps_quote(&tools.join("bash.exe").to_string_lossy()),
                    msys2_bash(tools)
                ),
            })
        }
        Os::MacOs => {
            let brew = find("brew")?;
            Some(Plan {
                manager: "Homebrew",
                command: format!("{} install tmux", sh_quote(&brew.to_string_lossy())),
            })
        }
        Os::Linux => {
            let (manager, arguments) = LINUX.into_iter().find(|(manager, _)| find(manager).is_some())?;
            // One quoted script for sudo's shell: `&&` then means the same in fish as in bash.
            let script = format!("sh -c {}", sh_quote(arguments));
            Some(Plan {
                manager,
                command: if find("sudo").is_some() {
                    format!("sudo {script}")
                } else {
                    script
                },
            })
        }
    }
}

fn msys2_bash(tools: &Path) -> String {
    format!(
        "& {} -lc {}",
        ps_quote(&tools.join("bash.exe").to_string_lossy()),
        ps_quote(PACMAN_TMUX)
    )
}

fn ps_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

fn sh_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(programs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<PathBuf> {
        move |name| {
            programs
                .iter()
                .find(|(program, _)| *program == name)
                .map(|(_, path)| PathBuf::from(path))
        }
    }

    #[test]
    fn windows_installs_msys2_with_winget_only_when_it_is_missing() {
        let fresh = plan(Os::Windows, found(&[("winget", r"C:\Apps\winget.exe")])).unwrap();
        assert_eq!(fresh.manager, "winget and MSYS2");
        assert_eq!(
            fresh.command,
            format!(
                "{WINGET_MSYS2}; if (Test-Path 'C:\\msys64\\usr\\bin\\bash.exe') {{ & 'C:\\msys64\\usr\\bin\\bash.exe' -lc '{PACMAN_TMUX}' }}"
            )
        );
        let existing = plan(
            Os::Windows,
            found(&[
                ("winget", r"C:\Apps\winget.exe"),
                ("pacman", r"D:\it's msys\usr\bin\pacman.exe"),
                ("bash", r"C:\Program Files\Git\bin\bash.exe"),
            ]),
        )
        .unwrap();
        assert_eq!(existing.manager, "MSYS2");
        assert_eq!(
            existing.command,
            format!("& 'D:\\it''s msys\\usr\\bin\\bash.exe' -lc '{PACMAN_TMUX}'")
        );
        // Git for Windows' bash is not MSYS2: without pacman or winget there is no plan.
        assert_eq!(
            plan(Os::Windows, found(&[("bash", r"C:\Program Files\Git\bin\bash.exe")])),
            None
        );
    }

    #[test]
    fn macos_uses_the_homebrew_it_found() {
        let plan = plan(Os::MacOs, found(&[("brew", "/opt/homebrew/bin/brew")])).unwrap();
        assert_eq!(
            (plan.manager, plan.command.as_str()),
            ("Homebrew", "'/opt/homebrew/bin/brew' install tmux")
        );
        assert_eq!(super::plan(Os::MacOs, found(&[])), None);
    }

    #[test]
    fn linux_prefers_the_common_manager_and_sudo_when_present() {
        let apt = plan(
            Os::Linux,
            found(&[
                ("dnf", "/usr/bin/dnf"),
                ("apt-get", "/usr/bin/apt-get"),
                ("sudo", "/usr/bin/sudo"),
            ]),
        )
        .unwrap();
        assert_eq!(apt.manager, "apt-get");
        assert_eq!(apt.command, "sudo sh -c 'apt-get update && apt-get install -y tmux'");
        let root = plan(Os::Linux, found(&[("apk", "/sbin/apk")])).unwrap();
        assert_eq!((root.manager, root.command.as_str()), ("apk", "sh -c 'apk add tmux'"));
        assert_eq!(plan(Os::Linux, found(&[("sudo", "/usr/bin/sudo")])), None);
    }

    #[test]
    fn usable_needs_a_recognized_supported_version() {
        let at = |version| Installed {
            binary: PathBuf::from("tmux"),
            version,
        };
        assert!(at(Some(Version { major: 3, minor: 3 })).usable());
        assert!(!at(Some(Version { major: 3, minor: 2 })).usable());
        assert!(!at(None).usable());
    }
}
