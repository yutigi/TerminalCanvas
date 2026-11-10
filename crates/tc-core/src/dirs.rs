//! Folder checks, from `src/directories.cjs`, and the app's data folder.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;

use crate::Platform;
use crate::js::utf16_len;
use crate::osc::is_absolute;

/// An absolute path to a folder this process can read.
pub fn is_directory(value: &str) -> bool {
    if value.is_empty() || utf16_len(value) > 4096 || value.contains('\0') || !is_absolute(value, Platform::current()) {
        return false;
    }
    fs::metadata(value).is_ok_and(|metadata| metadata.is_dir()) && readable(value)
}

/// [`is_directory`] for a value from the UI, which may not be a string at all.
pub fn is_directory_value(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(is_directory)
}

// Opening a folder needs the same read permission as Node's `fs.access(path, R_OK)`.
#[cfg(unix)]
fn readable(path: &str) -> bool {
    fs::File::open(path).is_ok()
}

// On Windows, Node's R_OK check only confirms that the path exists.
#[cfg(not(unix))]
fn readable(_path: &str) -> bool {
    true
}

/// The first candidate that is a readable folder, or an empty string.
pub fn fallback_directory<'a>(candidates: impl IntoIterator<Item = Option<&'a str>>) -> String {
    candidates
        .into_iter()
        .flatten()
        .find(|candidate| is_directory(candidate))
        .unwrap_or_default()
        .to_owned()
}

/// The folder the Electron build used, so autosave, images, and shell integration files carry
/// over: `terminal-canvas` in `%APPDATA%`, `~/Library/Application Support`, or `~/.config`.
pub fn app_data_dir() -> Option<PathBuf> {
    ::dirs::config_dir().map(|config| config.join("terminal-canvas"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_readable_absolute_folders_count() {
        let root = std::env::temp_dir().join(format!("tc-dirs-{}", uuid::Uuid::new_v4()));
        let nested = root.join("nested").join("project space");
        fs::create_dir_all(&nested).unwrap();
        let file = root.join("file.txt");
        fs::write(&file, "x").unwrap();
        let nested_text = nested.to_str().unwrap();
        assert!(is_directory(nested_text));
        assert!(!is_directory(file.to_str().unwrap()));
        assert!(!is_directory(root.join("missing").to_str().unwrap()));
        assert!(!is_directory("relative"));
        assert!(!is_directory("bad\0path"));
        assert!(!is_directory(""));
        assert!(!is_directory_value(Some(&serde_json::json!({}))));
        let root_text = root.to_str().unwrap();
        assert_eq!(
            fallback_directory([None, Some("relative"), Some(file.to_str().unwrap()), Some(root_text)]),
            root_text
        );
        assert_eq!(fallback_directory([None, Some("relative")]), "");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn data_folder_matches_electron() {
        let dir = app_data_dir().unwrap();
        assert_eq!(dir.file_name().unwrap(), "terminal-canvas");
        if cfg!(target_os = "macos") {
            assert!(dir.ends_with("Library/Application Support/terminal-canvas"));
        }
    }
}
