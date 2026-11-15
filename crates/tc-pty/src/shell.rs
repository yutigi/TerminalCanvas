//! Shell integration scripts, from `src/terminal-cwd.cjs` and `src/shell-integration.cjs`.
//!
//! The scripts live in `crates/tc-pty/shell/` and are embedded at build time. `{{SETTINGS}}` marks
//! where the quoted path of the Claude settings file goes. The golden tests compare the generated
//! text with the JavaScript host's output, with explicit differences for native hooks and Codex's
//! per-launch SessionStart hook.

use base64::Engine;

/// Wraps the prompt of PowerShell cards to report the directory (OSC 7) and whether the shell is
/// idle at a prompt (`777;tc-ready`). Profiles load first; the existing line reader and its
/// bindings are kept, because PSReadLine can buffer pasted input beyond what the console shows.
pub const POWERSHELL_BOOTSTRAP: &str = include_str!("../shell/bootstrap.ps1");
const POWERSHELL_AGENT: &str = include_str!("../shell/agent.ps1");
const BASH_INTEGRATION: &str = include_str!("../shell/integration.bash");
const SETTINGS: &str = "{{SETTINGS}}";
const CODEX_HOOK: &str = "{{CODEX_HOOK}}";

/// A PowerShell single-quoted string.
pub fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// A POSIX shell single-quoted string.
pub fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// The argument of `-EncodedCommand`: base64 of the UTF-16LE text.
pub fn encode_command(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Starts PowerShell with `script`. Windows PowerShell defaults to the Restricted policy, which
/// blocks `npm.ps1` and similar shims; a process-scoped RemoteSigned policy fixes that for this
/// shell only, and Group Policy still wins.
pub fn powershell_args(script: &str) -> Vec<String> {
    [
        "-NoLogo",
        "-NoExit",
        "-ExecutionPolicy",
        "RemoteSigned",
        "-EncodedCommand",
    ]
    .into_iter()
    .map(str::to_owned)
    .chain([encode_command(script)])
    .collect()
}

/// The PowerShell integration: the bootstrap plus `claude` and `codex` wrappers that report each
/// launch and pass Claude the settings file holding the session hook.
pub fn powershell_source(settings: &str) -> String {
    format!(
        "{POWERSHELL_BOOTSTRAP}{}",
        POWERSHELL_AGENT.replacen(SETTINGS, &ps_quote(settings), 1).replacen(
            CODEX_HOOK,
            &ps_quote(&codex_hook_config(true)),
            1
        )
    )
}

/// The Bash integration: the same wrappers, plus an OSC 7 directory report in `PROMPT_COMMAND`.
pub fn bash_source(settings: &str) -> String {
    BASH_INTEGRATION.replacen(SETTINGS, &sh_quote(settings), 1).replacen(
        CODEX_HOOK,
        &sh_quote(&codex_hook_config(false)),
        1,
    )
}

/// A launch-only Codex override. Hook sources from other config layers are merged by Codex;
/// user-supplied CLI overrides still take precedence. The command stays stable across terminals
/// so Codex can remember its trust decision, while the inherited environment identifies the card.
pub fn codex_hook_config(windows: bool) -> String {
    let command = if windows {
        let script = "$reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.Encoding]::UTF8); $payload = $reader.ReadToEnd(); $reader.Dispose(); $OutputEncoding = New-Object Text.UTF8Encoding $false; $payload | & $env:TC_HOOK record codex";
        format!(
            "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {}",
            encode_command(script)
        )
    } else {
        "\"$TC_HOOK\" record codex".to_owned()
    };
    // TOML literal strings survive Windows PowerShell's legacy native argument quoting,
    // including npm's codex.cmd shim. Neither fixed command contains an apostrophe.
    format!("hooks.SessionStart=[{{hooks=[{{type='command',command='{command}',timeout=5}}]}}]")
}

/// The Claude `SessionStart` hook command. On Windows it reads the hook input as UTF-8 before
/// passing it on, so directories with non-ASCII names survive the console code page.
pub fn claude_hook_command(hook: &str, windows: bool) -> String {
    if windows {
        let script = format!(
            "$reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.Encoding]::UTF8); $payload = $reader.ReadToEnd(); $reader.Dispose(); $OutputEncoding = New-Object Text.UTF8Encoding $false; $payload | & {} record claude",
            ps_quote(hook)
        );
        format!(
            "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {}",
            encode_command(&script)
        )
    } else {
        format!("{} record claude", sh_quote(hook))
    }
}

/// The Claude settings file: one `SessionStart` hook with a 5 second timeout.
pub fn claude_settings(hook: &str, windows: bool) -> String {
    let settings = serde_json::json!({
        "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": claude_hook_command(hook, windows), "timeout": 5 }] }] }
    });
    settings.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting() {
        assert_eq!(ps_quote("it's"), "'it''s'");
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
    }

    #[test]
    fn encoded_commands_are_utf16le_base64() {
        assert_eq!(encode_command("a"), "YQA=");
        assert_eq!(encode_command("子"), "UFs=");
    }
}
