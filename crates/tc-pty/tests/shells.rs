//! The integration scripts in real shells, from `tests/terminal-cwd.test.cjs` and
//! `tests/session-restoration.test.cjs`. Bash runs on macOS and Linux; PowerShell on Windows.

#[cfg(unix)]
use std::path::{Path, PathBuf};
use std::process::Command;

use tc_core::Platform;
use tc_core::osc::{DirectoryReports, Report};

#[cfg(unix)]
fn temp_folder(label: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let folder = std::env::temp_dir().join(format!("tc-shell-{label}-{nanos}"));
    std::fs::create_dir_all(&folder).unwrap();
    folder
}

fn reports(output: &[u8], platform: Platform) -> (Vec<Option<String>>, Vec<bool>) {
    let (mut directories, mut readiness) = (Vec::new(), Vec::new());
    DirectoryReports::new(platform, "unused").feed(&String::from_utf8_lossy(output), |report| match report {
        Report::Cwd(cwd) => directories.push(cwd),
        Report::Ready(ready) => readiness.push(ready),
    });
    (directories, readiness)
}

#[cfg(unix)]
#[test]
fn bash_loads_login_profiles_before_the_hooks_and_keeps_prompt_commands() {
    let bash = Path::new("/bin/bash");
    if !bash.exists() {
        return;
    }
    let folder = temp_folder("bash");
    std::fs::write(
        folder.join(".bash_profile"),
        "export TC_REVIEW_LOGIN=profile-loaded\n. \"$HOME/.bashrc\"\n",
    )
    .unwrap();
    std::fs::write(
        folder.join(".bashrc"),
        "TC_RC_COUNT=$(( ${TC_RC_COUNT:-0} + 1 ))\nPROMPT_COMMAND=(\":\" \"true\")\n",
    )
    .unwrap();
    let integration = tc_pty::integration::prepare(&folder, Path::new("/unused/tc-hook"), Platform::Linux, "/bin/bash")
        .unwrap()
        .unwrap();
    let command = integration.command.clone().unwrap();
    let script = format!(
        "{command}\nprintf 'login=%s rc=%s\\n' \"$TC_REVIEW_LOGIN\" \"$TC_RC_COUNT\"\nprintf 'prompt=%s\\n' \"${{PROMPT_COMMAND[*]}}\"\ndeclare -F claude codex\n__tc_cwd\n"
    );
    let output = Command::new(bash)
        .args(integration.args.clone().unwrap())
        .args(["-c", &script])
        .current_dir(&folder)
        .env("HOME", &folder)
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "{stdout}{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(stdout.contains("login=profile-loaded rc=1"), "{stdout}");
    assert!(stdout.contains("prompt=__tc_cwd : true"), "{stdout}");
    assert!(stdout.contains("claude\ncodex"), "{stdout}");
    let (directories, _) = reports(&output.stdout, Platform::current());
    let real = folder.canonicalize().unwrap();
    assert_eq!(
        directories,
        [Some(real.to_string_lossy().into_owned())],
        "OSC 7 reports the physical folder"
    );
    integration.cleanup();
    std::fs::remove_dir_all(folder).unwrap();
}

#[cfg(windows)]
mod powershell {
    use super::*;
    use tc_pty::shell::{POWERSHELL_BOOTSTRAP, encode_command};

    /// Runs a script; `None` when PowerShell 7 is not installed.
    fn run(executable: &str, script: &str) -> Option<std::process::Output> {
        match Command::new(executable)
            .args(["-NoLogo", "-NoProfile", "-EncodedCommand", &encode_command(script)])
            .output()
        {
            Ok(output) => Some(output),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && executable == "pwsh.exe" => None,
            Err(error) => panic!("{executable}: {error}"),
        }
    }

    fn cwd() -> String {
        std::env::current_dir().unwrap().to_string_lossy().into_owned()
    }

    fn checked(executable: &str, output: &std::process::Output) -> String {
        assert!(
            output.status.success(),
            "{executable}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&output.stderr), "", "{executable}");
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    #[test]
    fn the_prompt_keeps_custom_output_failed_status_and_native_exit_code() {
        let script = format!(
            "function global:prompt {{ \"CUSTOM:$?:$global:LASTEXITCODE>\" }}; {POWERSHELL_BOOTSTRAP}\n$global:LASTEXITCODE = 37; Write-Error 'expected failure' -ErrorAction SilentlyContinue\n$result = prompt; Write-Output ('RESULT=' + $result + ';LAST=' + $global:LASTEXITCODE)"
        );
        let output = run("powershell.exe", &script).unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(stdout.contains("RESULT=CUSTOM:False:37>;LAST=37"), "{stdout}");
        assert_eq!(reports(&output.stdout, Platform::Windows).0, [Some(cwd())]);
    }

    #[test]
    fn buffered_line_acceptance_clears_readiness_and_keeps_reader_output() {
        for executable in ["powershell.exe", "pwsh.exe"] {
            let script = format!(
                "$ProgressPreference = 'SilentlyContinue'\nSet-StrictMode -Version Latest\nfunction global:prompt {{ 'CUSTOM>' }}\nfunction global:PSConsoleHostReadLine {{ 'BUFFERED:' + $? + ':' + $global:LASTEXITCODE }}\n{POWERSHELL_BOOTSTRAP}\n$global:LASTEXITCODE = 37\n$result = prompt\nWrite-Error 'expected failure' -ErrorAction SilentlyContinue\n$line = PSConsoleHostReadLine\nWrite-Output ('LINE=' + $line + ';LAST=' + $global:LASTEXITCODE)\n$result = prompt\n$line = PSConsoleHostReadLine\nWrite-Output ('LINE2=' + $line)\nfunction global:PSConsoleHostReadLine {{ throw 'reader failed' }}\n$result = prompt"
            );
            let Some(output) = run(executable, &script) else {
                continue;
            };
            let stdout = checked(executable, &output);
            assert!(
                stdout.contains("LINE=BUFFERED:False:37;LAST=37"),
                "{executable}: {stdout}"
            );
            assert!(stdout.contains("LINE2=BUFFERED:True:37"), "{executable}: {stdout}");
            assert_eq!(
                reports(&output.stdout, Platform::Windows).1,
                [true, false, true, false, false],
                "{executable}"
            );
        }
    }

    #[test]
    fn missing_or_throwing_readers_never_leave_readiness_on() {
        for executable in ["powershell.exe", "pwsh.exe"] {
            for reader in ["", "function global:PSConsoleHostReadLine { throw 'reader failed' }"] {
                let call = if reader.is_empty() {
                    ""
                } else {
                    "try { PSConsoleHostReadLine } catch { Write-Output ('CAUGHT=' + $_.Exception.Message) }"
                };
                let script = format!(
                    "$ProgressPreference = 'SilentlyContinue'\nSet-StrictMode -Version Latest\nRemove-Item Function:PSConsoleHostReadLine -ErrorAction Ignore\nfunction global:prompt {{ 'CUSTOM>' }}\n{reader}\n{POWERSHELL_BOOTSTRAP}\n$result = prompt\n{call}"
                );
                let Some(output) = run(executable, &script) else {
                    continue;
                };
                let stdout = checked(executable, &output);
                let expected: &[bool] = if reader.is_empty() { &[false] } else { &[true, false] };
                assert_eq!(
                    reports(&output.stdout, Platform::Windows).1,
                    expected,
                    "{executable} {reader:?}"
                );
                if !reader.is_empty() {
                    assert!(stdout.contains("CAUGHT=reader failed"), "{executable}: {stdout}");
                }
            }
        }
    }

    #[test]
    fn the_prompt_supports_strict_mode_with_and_without_lastexitcode() {
        for executable in ["powershell.exe", "pwsh.exe"] {
            let script = format!(
                "Set-StrictMode -Version Latest\n$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'\nRemove-Variable -Name LASTEXITCODE -Scope Global -ErrorAction Ignore\nfunction global:prompt {{ \"CUSTOM:$?>\" }}\n{POWERSHELL_BOOTSTRAP}\nWrite-Error 'expected failure' -ErrorAction SilentlyContinue\n$result = prompt\n$exists = $null -ne (Get-Variable -Name LASTEXITCODE -Scope Global -ErrorAction Ignore)\nWrite-Output ('RESULT=' + $result + ';EXISTS=' + $exists)\n$global:LASTEXITCODE = 37\nWrite-Error 'expected failure' -ErrorAction SilentlyContinue\n$result = prompt\nWrite-Output ('RESULT2=' + $result + ';LAST=' + $global:LASTEXITCODE)"
            );
            let Some(output) = run(executable, &script) else {
                continue;
            };
            let stdout = checked(executable, &output);
            assert!(
                stdout.contains("RESULT=CUSTOM:False>;EXISTS=False"),
                "{executable}: {stdout}"
            );
            assert!(
                stdout.contains("RESULT2=CUSTOM:False>;LAST=37"),
                "{executable}: {stdout}"
            );
            assert_eq!(
                reports(&output.stdout, Platform::Windows).0,
                [Some(cwd()), Some(cwd())],
                "{executable}"
            );
        }
    }
}
