//! Read-only JavaScript syntax and manifest checks, replacing scripts/check.cjs.
use std::path::{Path, PathBuf};
use std::process::Command;

fn collect(folder: &Path, scripts: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in std::fs::read_dir(folder).map_err(|error| format!("{}: {error}", folder.display()))? {
        let entry = entry.map_err(|error| error.to_string())?;
        let kind = entry.file_type().map_err(|error| error.to_string())?;
        let path = entry.path();
        if kind.is_dir() {
            collect(&path, scripts)?;
        } else if kind.is_file()
            && matches!(
                path.extension().and_then(|ext| ext.to_str()),
                Some("js" | "cjs" | "mjs")
            )
        {
            scripts.push(path);
        }
    }
    Ok(())
}

pub fn check(root: &Path) -> Result<(), String> {
    let mut scripts = Vec::new();
    for folder in ["src", "scripts", "tests"] {
        collect(&root.join(folder), &mut scripts)?;
    }
    scripts.sort();
    for script in scripts {
        let output = Command::new("node")
            .arg("--check")
            .arg(&script)
            .current_dir(root)
            .output()
            .map_err(|error| format!("could not check {}: {error}", script.display()))?;
        if !output.status.success() {
            return Err(format!(
                "JavaScript syntax check failed: {}\n{}",
                script.display(),
                String::from_utf8_lossy(&output.stderr)
            ));
        }
    }
    let file = root.join("package.json");
    let text = std::fs::read_to_string(&file).map_err(|error| format!("{}: {error}", file.display()))?;
    serde_json::from_str::<serde_json::Value>(&text).map_err(|error| format!("{}: {error}", file.display()))?;
    println!("JavaScript syntax and package.json checks passed.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checks_nested_scripts_without_executing_them_and_propagates_syntax_errors() {
        let root = std::env::temp_dir().join(format!("tc-syntax-{}", std::process::id()));
        for folder in ["src", "scripts", "tests/nested"] {
            std::fs::create_dir_all(root.join(folder)).unwrap();
        }
        std::fs::write(root.join("package.json"), "{}").unwrap();
        let script = root.join("tests/nested/fixture.cjs");
        std::fs::write(&script, "throw new Error('Syntax checking must never execute this.');").unwrap();
        let valid = check(&root);
        std::fs::write(&script, "const = ;").unwrap();
        let invalid = check(&root);
        std::fs::remove_dir_all(&root).unwrap();
        assert!(valid.is_ok());
        assert!(invalid.unwrap_err().contains("fixture.cjs"));
    }
}
