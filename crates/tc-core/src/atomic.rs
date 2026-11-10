//! Atomic file replacement: write a temporary file next to the target, then rename it over the target.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Who may read the written file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    /// The process default.
    Default,
    /// Owner only (mode 0600 on Unix). Used for hook and session files.
    Private,
}

/// Replaces `path` with `bytes`, so readers see the old file or the new one, never a partial write.
/// The temporary file is named `<path>.<uuid>.tmp` and is removed if anything fails. On Windows the
/// rename replaces an existing file.
pub fn write(path: &Path, bytes: &[u8], access: Access) -> io::Result<()> {
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let temporary = PathBuf::from(temporary);
    let result = write_new(&temporary, bytes, access).and_then(|()| fs::rename(&temporary, path));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn write_new(path: &Path, bytes: &[u8], access: Access) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    if access == Access::Private {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(not(unix))]
    let _ = access;
    options.open(path)?.write_all(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_existing_files_and_leaves_no_temporary_files() {
        let dir = std::env::temp_dir().join(format!("tc-atomic-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("workspace.terminalcanvas");
        write(&file, b"one", Access::Default).unwrap();
        write(&file, b"two", Access::Private).unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"two");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert!(write(&dir.join("missing").join("file"), b"x", Access::Default).is_err());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }
}
