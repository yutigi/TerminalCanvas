//! Read only the captured session's name metadata, using the CLI's launch-time config home.
//! Never invoke a CLI, read auth/config files, or use prompts as a title fallback.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

use serde::Deserialize;
use tc_core::session::{Provider, SessionMetadata};
use tc_core::titles::session_title;

use crate::SessionKey;

const WINDOW: u64 = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NameRequest {
    pub key: SessionKey,
    pub launch_token: String,
    pub session: SessionMetadata,
    pub home: PathBuf,
}

/// Only these metadata fields are retained by the decoder; conversation contents are ignored.
#[derive(Deserialize)]
struct NameLine {
    #[serde(default)]
    id: String,
    #[serde(default, rename = "sessionId")]
    session_id: String,
    #[serde(default)]
    thread_name: Option<String>,
    #[serde(default, rename = "customTitle")]
    custom_title: Option<String>,
    #[serde(default, rename = "aiTitle")]
    ai_title: Option<String>,
}

impl NameRequest {
    pub fn read(&self) -> Option<String> {
        let file = match self.session.provider {
            Provider::Codex => self.home.join("session_index.jsonl"),
            Provider::Claude => {
                // Match the SDK's short-path encoding. Long/hash-encoded paths deliberately
                // fall back rather than searching another project's conversations.
                let project: String = self
                    .session
                    .cwd
                    .chars()
                    .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
                    .collect();
                if project.len() > 200 {
                    return None;
                }
                self.home
                    .join("projects")
                    .join(project)
                    .join(format!("{}.jsonl", self.session.session_id))
            }
        };
        let mut file = File::open(file).ok()?;
        let size = file.metadata().ok()?.len();
        // Read a bounded tail, as the upstream CLIs do. Complete JSONL metadata records only.
        let mut custom = None;
        let mut automatic = None;
        let offsets = if size > WINDOW && self.session.provider == Provider::Claude {
            vec![0, size - WINDOW]
        } else {
            vec![size.saturating_sub(WINDOW)]
        };
        for offset in offsets {
            file.seek(SeekFrom::Start(offset)).ok()?;
            let mut bytes = Vec::new();
            (&mut file).take(WINDOW).read_to_end(&mut bytes).ok()?;
            let text = String::from_utf8_lossy(&bytes);
            for (index, line) in text.lines().enumerate() {
                if index == 0 && offset > 0 {
                    continue;
                }
                let Ok(line) = serde_json::from_str::<NameLine>(line) else {
                    continue;
                };
                match self.session.provider {
                    Provider::Codex if line.id.eq_ignore_ascii_case(&self.session.session_id) => {
                        automatic = line.thread_name.as_deref().and_then(session_title);
                    }
                    Provider::Claude
                        if line.session_id.is_empty()
                            || line.session_id.eq_ignore_ascii_case(&self.session.session_id) =>
                    {
                        if line.custom_title.is_some() {
                            custom = line.custom_title.as_deref().and_then(session_title);
                        }
                        if line.ai_title.is_some() {
                            automatic = line.ai_title.as_deref().and_then(session_title);
                        }
                    }
                    _ => {}
                }
            }
        }
        custom.or(automatic)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    const ID: &str = "12345678-1234-4321-9876-123456789abc";

    fn request(home: &std::path::Path, provider: Provider) -> NameRequest {
        NameRequest {
            launch_token: "test-launch".into(),
            key: SessionKey {
                id: "card".into(),
                generation: 1,
            },
            session: SessionMetadata {
                provider,
                session_id: ID.into(),
                cwd: "/repo".into(),
            },
            home: home.into(),
        }
    }

    #[test]
    fn codex_uses_the_latest_matching_name_and_never_prompt_or_auth_fields() {
        let home = std::env::temp_dir().join(format!("tc-name-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&home).unwrap();
        let request = request(&home, Provider::Codex);
        assert_eq!(request.read(), None);
        let file = home.join("session_index.jsonl");
        let content = format!(
            "{}\n{}\n{}\n{{partial",
            json!({"id": ID, "thread_name": "Old"}),
            json!({"id": ID, "thread_name": "Fix ไทย 🚀", "api_key": "NEVER_USE", "first_prompt": "SECRET_PROMPT"}),
            json!({"id": "unrelated", "thread_name": "Wrong session"})
        );
        fs::write(&file, content).unwrap();
        assert_eq!(request.read().as_deref(), Some("Fix ไทย 🚀"));
        fs::write(
            &file,
            json!({"id": ID, "first_prompt": "SECRET_PROMPT", "auth": "NEVER_USE"}).to_string(),
        )
        .unwrap();
        assert_eq!(request.read(), None);
        fs::write(
            &file,
            format!("{}\n", json!({"id": ID, "thread_name": "bad\u{1b}title"})),
        )
        .unwrap();
        assert_eq!(request.read(), None);
        fs::write(
            &file,
            format!("{}\n", json!({"id": ID, "thread_name": "🚀".repeat(60)})),
        )
        .unwrap();
        assert_eq!(request.read().unwrap(), "🚀".repeat(50));
        // A bounded tail beginning inside a record must not parse that partial record.
        fs::write(
            &file,
            format!(
                "{}\n{}\n",
                "x".repeat(100_000),
                json!({"id": ID, "thread_name": "Tail name"})
            ),
        )
        .unwrap();
        assert_eq!(request.read().as_deref(), Some("Tail name"));
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn claude_reads_only_named_metadata_for_the_captured_project_session_and_account() {
        let home = std::env::temp_dir().join(format!("tc-name-{}", uuid::Uuid::new_v4()));
        let project = home.join("projects/-repo");
        fs::create_dir_all(&project).unwrap();
        let mut request = request(&home, Provider::Claude);
        let file = project.join(format!("{ID}.jsonl"));
        fs::write(
            &file,
            format!(
                "{}\n{}\n{}\n",
                json!({"type":"ai-title", "sessionId":ID,"aiTitle":"Generated name"}),
                json!({"type":"user", "message":{"content":"SECRET_PROMPT"}}),
                json!({"sessionId":"unrelated", "aiTitle":"Wrong session"})
            ),
        )
        .unwrap();
        assert_eq!(request.read().as_deref(), Some("Generated name"));
        fs::write(
            &file,
            format!(
                "{}\n{}\n{}\n",
                json!({"customTitle":"Chosen in Claude"}),
                " ".repeat(100_000),
                json!({"aiTitle":"Later generated name"})
            ),
        )
        .unwrap();
        assert_eq!(request.read().as_deref(), Some("Chosen in Claude"));
        request.home = home.join("other-account");
        assert_eq!(request.read(), None);
        request.home = home.clone();
        request.session.cwd = "/other-project".into();
        assert_eq!(request.read(), None);
        fs::remove_dir_all(home).unwrap();
    }
}
