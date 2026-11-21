use std::env;
use std::io;
use std::path::PathBuf;
use std::process::{Command, ExitCode};

use tc_core::{pointers::PromptLaunch, session::Provider};
use tc_pty::integration::{SESSION_ENV, TOKEN_ENV};

pub fn run(id: &str) -> ExitCode {
    match launch(id) {
        Ok(code) => ExitCode::from(u8::try_from(code).unwrap_or(1)),
        Err(error) => {
            eprintln!("tc-hook: could not start the AI prompt: {error}");
            ExitCode::FAILURE
        }
    }
}

fn launch(id: &str) -> io::Result<i32> {
    let inbox = env::var_os(tc_core::launch::ENV).ok_or_else(|| io::Error::other("No terminal hook inbox."))?;
    let launch = PromptLaunch::take(inbox.as_ref(), id)?;
    let name = launch.provider.as_str();
    let mut command = provider_command(launch.provider)?;
    match launch.provider {
        Provider::Claude => {
            let session_file = env::var_os(SESSION_ENV)
                .map(PathBuf::from)
                .ok_or_else(|| io::Error::other("No Claude hook settings for this terminal."))?;
            command
                .arg("--settings")
                .arg(session_file.with_extension("settings.json"));
        }
        Provider::Codex => {
            for config in tc_pty::shell::codex_hook_arguments(cfg!(windows)) {
                command.args(["-c", &config]);
            }
        }
    }
    if let Some(model) = launch.model.as_deref() {
        command.args(["--model", model]);
    }
    // Keep the prompt in a positional argument, including when it begins with a CLI option.
    command.args(["--", &launch.text]).env(TOKEN_ENV, id);
    super::emit_with_token(Some("launch"), Some(name), None, Some(id));
    let result = command.status();
    let code = result
        .as_ref()
        .ok()
        .and_then(std::process::ExitStatus::code)
        .unwrap_or(1);
    super::emit_with_token(Some("end"), Some(&code.to_string()), None, Some(id));
    result.map(|_| code)
}

#[cfg(not(windows))]
fn provider_command(provider: Provider) -> io::Result<Command> {
    Ok(Command::new(provider.as_str()))
}

#[cfg(windows)]
fn provider_command(provider: Provider) -> io::Result<Command> {
    let path = env::var_os("PATH").unwrap_or_default();
    let name = provider.as_str();
    for folder in env::split_paths(&path).filter(|folder| folder.is_absolute()) {
        for extension in ["exe", "cmd", "bat"] {
            let executable = folder.join(format!("{name}.{extension}"));
            if !executable.is_file() {
                continue;
            }
            // The standard npm shim forwards through cmd.exe. Call its Node entry point directly
            // so multiline text and shell metacharacters stay in one native argument.
            if provider == Provider::Codex && extension == "cmd" {
                let script = folder.join("node_modules/@openai/codex/bin/codex.js");
                if script.is_file() {
                    let node = folder.join("node.exe");
                    let mut command = Command::new(if node.is_file() { node } else { "node.exe".into() });
                    command.arg(script);
                    return Ok(command);
                }
            }
            return Ok(Command::new(executable));
        }
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        format!("{name} is unavailable on PATH."),
    ))
}
