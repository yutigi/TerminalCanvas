//! The Terminal Canvas skill (`skills/terminal-canvas/SKILL.md`) and where AI agents look for it.
//!
//! Agents that read the Agent Skills format load user-wide skills from a folder in the home folder:
//! Claude Code from `skills` in its configuration folder (`~/.claude`, or `CLAUDE_CONFIG_DIR`, and
//! each Terminal Canvas account folder), and Codex, Gemini CLI, opencode, and others from
//! `~/.agents/skills`. Installing writes `<skills>/terminal-canvas/SKILL.md` and touches nothing
//! else in those folders.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::atomic::{self, Access};

/// The skill's folder name, and the `name` in its front matter.
pub const NAME: &str = "terminal-canvas";
/// The skill as this build ships it.
pub const SKILL: &str = include_str!("../../../skills/terminal-canvas/SKILL.md");
/// A target the setup can install to, as the UI names it.
pub const TARGETS: [&str; 2] = ["claude", "agents"];

/// How a target's copies compare with [`SKILL`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    /// No copy is installed.
    Missing,
    /// Every copy matches this build's skill.
    Current,
    /// Some copies are missing or differ from this build's skill.
    Outdated,
}

/// One place the setup installs the skill, and the agents that read it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Target {
    pub id: &'static str,
    pub name: &'static str,
    /// The `skills` folders the skill goes in.
    pub folders: Vec<PathBuf>,
    /// The agents among those this target serves that have a configuration folder here.
    pub detected: Vec<&'static str>,
    pub status: Status,
}

/// The skill file inside a `skills` folder.
pub fn file(skills: &Path) -> PathBuf {
    skills.join(NAME).join("SKILL.md")
}

fn installed(skills: &Path) -> Option<bool> {
    let file = file(skills);
    // A copy far larger than the skill cannot match it; it is not worth reading.
    if fs::metadata(&file).ok()?.len() > 4 * SKILL.len() as u64 {
        return Some(false);
    }
    Some(fs::read(file).ok()? == SKILL.as_bytes())
}

fn status(folders: &[PathBuf]) -> Status {
    let copies: Vec<Option<bool>> = folders.iter().map(|folder| installed(folder)).collect();
    if copies.iter().all(Option::is_none) {
        Status::Missing
    } else if copies.iter().all(|copy| *copy == Some(true)) {
        Status::Current
    } else {
        Status::Outdated
    }
}

/// Where the skill goes. `home` is the user's home folder, `claude_config` the `CLAUDE_CONFIG_DIR`
/// shells inherit (if set), and `accounts` the account folders from [`crate::accounts`].
pub fn targets(home: &Path, claude_config: Option<&Path>, accounts: &[PathBuf]) -> Vec<Target> {
    let claude = claude_config.map_or_else(|| home.join(".claude"), Path::to_path_buf);
    let mut claude_folders = vec![claude.join("skills")];
    claude_folders.extend(accounts.iter().map(|account| account.join("skills")));
    let found = |folder: PathBuf| folder.is_dir();
    let claude_detected = if found(claude) || found(home.join(".claude")) || !accounts.is_empty() {
        vec!["Claude Code"]
    } else {
        Vec::new()
    };
    let shared = home.join(".agents").join("skills");
    let shared_detected = [
        ("Codex", home.join(".codex")),
        ("Gemini CLI", home.join(".gemini")),
        ("opencode", home.join(".config").join("opencode")),
    ]
    .into_iter()
    .filter_map(|(agent, folder)| found(folder).then_some(agent))
    .collect();
    vec![
        Target {
            id: TARGETS[0],
            name: "Claude Code",
            status: status(&claude_folders),
            folders: claude_folders,
            detected: claude_detected,
        },
        Target {
            id: TARGETS[1],
            name: "Codex, Gemini CLI, opencode, and other agents",
            status: status(std::slice::from_ref(&shared)),
            folders: vec![shared],
            detected: shared_detected,
        },
    ]
}

/// Writes this build's skill into each of `target`'s folders, replacing an older copy. Stops at
/// the first folder that fails and names it.
pub fn install(target: &Target) -> Result<(), String> {
    for skills in &target.folders {
        let file = file(skills);
        let written = file
            .parent()
            .map_or(Ok(()), fs::create_dir_all)
            .and_then(|()| atomic::write(&file, SKILL.as_bytes(), Access::Default));
        if let Err(error) = written {
            return Err(failure(&file, &error));
        }
    }
    Ok(())
}

fn failure(file: &Path, error: &io::Error) -> String {
    format!("Could not install the skill in {}: {error}", file.display())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary() -> PathBuf {
        let root = std::env::temp_dir().join(format!("tc-skills-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn the_shipped_skill_names_itself() {
        assert!(
            SKILL.starts_with("---\nname: terminal-canvas\n") || SKILL.starts_with("---\r\nname: terminal-canvas\r\n")
        );
        assert!(SKILL.contains("description:"));
    }

    #[test]
    fn targets_cover_claude_code_and_the_shared_agent_folder() {
        let home = temporary();
        let none = targets(&home, None, &[]);
        assert_eq!(none.iter().map(|t| t.id).collect::<Vec<_>>(), TARGETS);
        assert_eq!(none[0].folders, [home.join(".claude").join("skills")]);
        assert_eq!(none[1].folders, [home.join(".agents").join("skills")]);
        assert!(
            none.iter()
                .all(|t| t.detected.is_empty() && t.status == Status::Missing)
        );

        fs::create_dir_all(home.join(".codex")).unwrap();
        fs::create_dir_all(home.join(".config").join("opencode")).unwrap();
        let config = home.join("custom-claude");
        fs::create_dir_all(&config).unwrap();
        let account = home.join("accounts").join("Work");
        let found = targets(&home, Some(&config), std::slice::from_ref(&account));
        assert_eq!(found[0].folders, [config.join("skills"), account.join("skills")]);
        assert_eq!(found[0].detected, ["Claude Code"]);
        assert_eq!(found[1].detected, ["Codex", "opencode"]);
        fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn installing_writes_each_copy_and_reports_its_status() {
        let home = temporary();
        let account = home.join("accounts").join("Work");
        let list = || targets(&home, None, std::slice::from_ref(&account));
        let claude = &list()[0];
        // Unrelated skills in the same folder stay as they are.
        let other = home.join(".claude").join("skills").join("other").join("SKILL.md");
        fs::create_dir_all(other.parent().unwrap()).unwrap();
        fs::write(&other, "mine").unwrap();
        install(claude).unwrap();
        assert_eq!(list()[0].status, Status::Current);
        assert_eq!(list()[1].status, Status::Missing);
        assert_eq!(fs::read_to_string(file(&account.join("skills"))).unwrap(), SKILL);
        assert_eq!(fs::read_to_string(&other).unwrap(), "mine");

        fs::write(file(&account.join("skills")), "an older skill").unwrap();
        assert_eq!(list()[0].status, Status::Outdated);
        install(&list()[0]).unwrap();
        assert_eq!(list()[0].status, Status::Current);

        let blocked = home.join(".agents");
        fs::write(&blocked, "a file where the folder belongs").unwrap();
        let error = install(&list()[1]).unwrap_err();
        assert!(error.starts_with("Could not install the skill in "), "{error}");
        assert!(error.contains("SKILL.md"), "{error}");
        fs::remove_dir_all(&home).unwrap();
    }
}
