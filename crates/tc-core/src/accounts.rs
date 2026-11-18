//! Claude Code accounts a terminal can run as.
//!
//! Claude Code keeps its sign-in, settings, and sessions in the folder `CLAUDE_CONFIG_DIR` names
//! (`~/.claude` by default). Each named account is one such folder under the app's data folder, so
//! terminals on the same canvas can be signed in to different accounts. A card names its account
//! in `claudeAccount`; a card without one uses the shell's own setting.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::js::utf16_len;
use crate::{Result, invalid};

/// The folder under the app's data folder that holds one folder per account.
pub const DIR: &str = "claude-accounts";
/// The variable Claude Code reads its configuration folder from.
pub const ENV: &str = "CLAUDE_CONFIG_DIR";
/// The longest account name, in UTF-16 units.
pub const NAME_MAX: usize = 40;
/// The most accounts the UI lists.
pub const LIMIT: usize = 100;

const RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2",
    "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// An account name, trimmed: letters, digits, spaces, `-` and `_`. It is also the account's
/// folder name, so it avoids every character and device name a file system could reject.
pub fn name(value: &str) -> Option<String> {
    let name = value.trim();
    let valid = !name.is_empty()
        && utf16_len(name) <= NAME_MAX
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '-' | '_'))
        && !RESERVED.contains(&name.to_ascii_lowercase().as_str());
    valid.then(|| name.to_owned())
}

/// [`name`] for a value from the UI, with the message it shows.
pub fn validate_name(value: Option<&serde_json::Value>) -> Result<String> {
    match value.and_then(serde_json::Value::as_str).and_then(name) {
        Some(name) => Ok(name),
        None => invalid(format!(
            "Account names use 1 to {NAME_MAX} letters, digits, spaces, hyphens, or underscores."
        )),
    }
}

/// The folder an account keeps its Claude Code configuration in.
pub fn folder(root: &Path, name: &str) -> PathBuf {
    root.join(name)
}

/// The accounts in `root`, sorted without regard to case. A missing `root` has none.
pub fn list(root: &Path) -> io::Result<Vec<String>> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut names: Vec<String> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            entry.file_type().ok()?.is_dir().then_some(())?;
            let file_name = entry.file_name().into_string().ok()?;
            name(&file_name).filter(|name| *name == file_name)
        })
        .collect();
    names.sort_by_key(|name| name.to_ascii_lowercase());
    names.truncate(LIMIT);
    Ok(names)
}

/// Creates an account's folder unless an account with that name, in any case, already exists.
/// Returns the account's name as stored.
pub fn create(root: &Path, name: &str) -> Result<String> {
    let existing = list(root)?;
    if let Some(found) = existing.iter().find(|other| other.eq_ignore_ascii_case(name)) {
        return Ok(found.clone());
    }
    if existing.len() >= LIMIT {
        return invalid(format!("Terminal Canvas keeps at most {LIMIT} Claude accounts."));
    }
    fs::create_dir_all(folder(root, name))?;
    Ok(name.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_safe_folder_names() {
        assert_eq!(name("  Work account "), Some("Work account".into()));
        assert_eq!(name("personal_2-b"), Some("personal_2-b".into()));
        for bad in [
            "",
            "   ",
            "a/b",
            "a\\b",
            "..",
            "a.b",
            "con",
            "COM1",
            "x:y",
            "née",
            &"a".repeat(41),
        ] {
            assert_eq!(name(bad), None, "{bad}");
        }
        assert!(name(&"a".repeat(40)).is_some());
        assert_eq!(
            validate_name(Some(&serde_json::json!(5))).unwrap_err().to_string(),
            "Account names use 1 to 40 letters, digits, spaces, hyphens, or underscores."
        );
    }

    #[test]
    fn accounts_are_the_named_folders() {
        let root = std::env::temp_dir().join(format!("tc-accounts-{}", uuid::Uuid::new_v4()));
        assert_eq!(list(&root).unwrap(), Vec::<String>::new());
        assert_eq!(create(&root, "work").unwrap(), "work");
        assert_eq!(create(&root, "Personal").unwrap(), "Personal");
        assert_eq!(create(&root, "WORK").unwrap(), "work");
        fs::write(root.join("notes"), "").unwrap();
        fs::create_dir_all(root.join("bad.name")).unwrap();
        assert_eq!(list(&root).unwrap(), ["Personal", "work"]);
        assert!(folder(&root, "work").is_dir());
        fs::remove_dir_all(&root).unwrap();
    }
}
