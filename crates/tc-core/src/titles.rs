//! Local terminal naming policy. No prompts, credentials, or conversation text are inputs.

use crate::js::{trim, utf16_len};
use crate::workspace::Card;

string_enum! {
    pub enum TitleMode { Automatic = "automatic", Manual = "manual" }
}

/// Additional display metadata is best effort. Existing title validation stays unchanged.
pub fn valid_title(value: &str) -> Option<String> {
    let value = trim(value);
    (!value.is_empty()
        && utf16_len(value) <= 100
        && !value
            .chars()
            .any(|c| c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')))
    .then(|| value.to_owned())
}

/// CLI names can be longer than workspace titles. Truncate on a Unicode scalar boundary.
pub fn session_title(value: &str) -> Option<String> {
    if value
        .chars()
        .any(|c| c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
    {
        return None;
    }
    let mut units = 0;
    let title: String = trim(value)
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= 100
        })
        .collect();
    valid_title(&title)
}

pub fn fallback(card: &Card) -> String {
    let project = card
        .cwd
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("");
    let profile = card.profile.profile().name;
    session_title(&format!("{project} · {profile}"))
        .filter(|_| !project.is_empty())
        .unwrap_or_else(|| profile.to_owned())
}

/// One pending local name. Repeated observations do not restart the settling delay.
#[derive(Debug, Default)]
pub struct SettledTitle {
    pending: Option<(String, u64)>,
    last_applied: Option<u64>,
}

impl SettledTitle {
    pub fn observe(&mut self, title: String, now: u64) {
        if self.pending.as_ref().is_none_or(|(previous, _)| previous != &title) {
            self.pending = Some((title, now));
        }
    }

    /// Five seconds to settle; at most one visible change a minute thereafter.
    pub fn ready(&mut self, current: &str, now: u64) -> Option<String> {
        let (title, since) = self.pending.as_ref()?;
        if title == current
            || now.saturating_sub(*since) < 5
            || self.last_applied.is_some_and(|last| now.saturating_sub(last) < 60)
        {
            return None;
        }
        self.last_applied = Some(now);
        Some(title.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_plain_bounded_unicode() {
        assert_eq!(session_title("  Fix ไทย 🚀  ").as_deref(), Some("Fix ไทย 🚀"));
        assert_eq!(session_title(&"🚀".repeat(60)).unwrap(), "🚀".repeat(50));
        for value in ["", "  ", "secret\nvalue", "x\u{7f}", "x\u{202e}"] {
            assert_eq!(session_title(value), None);
        }
        assert!(valid_title(&"🚀".repeat(51)).is_none());
    }

    #[test]
    fn repeated_observations_settle_and_changes_are_rate_limited() {
        let mut state = SettledTitle::default();
        state.observe("First task".into(), 0);
        state.observe("First task".into(), 4);
        assert_eq!(state.ready("Project", 4), None);
        assert_eq!(state.ready("Project", 5).as_deref(), Some("First task"));
        assert_eq!(state.ready("First task", 10), None);
        state.observe("Second task".into(), 11);
        assert_eq!(state.ready("First task", 64), None);
        assert_eq!(state.ready("First task", 65).as_deref(), Some("Second task"));
    }
}
