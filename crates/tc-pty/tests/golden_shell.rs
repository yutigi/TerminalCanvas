//! The generated shell integration text matches the JavaScript host's output byte for byte
//! (`tests/golden/shell/`), except for the intended hook changes: Bash runs `"$TC_HOOK"` directly,
//! and Claude's hook runs `tc-hook record claude` instead of Electron as Node.

use std::path::{Path, PathBuf};

use serde_json::Value;
use tc_core::Platform;
use tc_pty::integration::prepare;
use tc_pty::shell::{
    POWERSHELL_BOOTSTRAP, bash_source, claude_hook_command, claude_settings, encode_command, powershell_args,
    powershell_source,
};

fn golden(name: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/golden/shell")
        .join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

fn golden_json(name: &str) -> Value {
    serde_json::from_str(&golden(name)).unwrap()
}

const WINDOWS_SETTINGS: &str = "C:\\Users\\tc\\AppData\\Roaming\\terminal-canvas\\shell-integration\\00000000-0000-4000-8000-000000000000.settings.json";
const UNIX_SETTINGS: &str =
    "/home/tc/.config/terminal-canvas/shell-integration/00000000-0000-4000-8000-000000000000.settings.json";
const JS_BASH_HOOK: &str = "ELECTRON_RUN_AS_NODE=1 \"$TC_NODE\" \"$TC_HOOK\" emit";

#[test]
fn powershell_text_is_unchanged() {
    assert_eq!(POWERSHELL_BOOTSTRAP, golden("powershell-bootstrap.ps1"));
    let args: Value = powershell_args(POWERSHELL_BOOTSTRAP).into_iter().collect();
    assert_eq!(args, golden_json("powershell-args.json"));
    assert_eq!(powershell_source(WINDOWS_SETTINGS), golden("powershell-source.ps1"));
    assert_eq!(
        powershell_source("C:\\Users\\O'Brien\\it's.settings.json"),
        golden("powershell-source-quoted.ps1")
    );
}

#[test]
fn bash_text_differs_only_in_how_it_runs_the_hook() {
    for (settings, file) in [
        (UNIX_SETTINGS, "bash-source.bash"),
        ("/home/o'brien/it's.settings.json", "bash-source-quoted.bash"),
    ] {
        let javascript = golden(file);
        assert_eq!(javascript.matches(JS_BASH_HOOK).count(), 2);
        assert_eq!(
            bash_source(settings),
            javascript.replace(JS_BASH_HOOK, "\"$TC_HOOK\" emit")
        );
    }
}

fn hook_command(settings: &Value) -> &str {
    settings["hooks"]["SessionStart"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap()
}

#[test]
fn claude_settings_keep_the_utf8_bridge_and_run_tc_hook() {
    let javascript = golden_json("claude-settings.json");
    let hook = "{{HOOK}}";
    for (platform, windows) in [("win32", true), ("linux", false), ("darwin", false)] {
        let expected = &javascript[platform]["settings"];
        let mut rust: Value = serde_json::from_str(&claude_settings(hook, windows)).unwrap();
        let command = hook_command(&rust).to_owned();
        if windows {
            let (prefix, encoded) = command.split_once(" -EncodedCommand ").unwrap();
            assert_eq!(encoded, encode_command(&decode_command(encoded)));
            let js_script = javascript[platform]["encodedCommand"].as_str().unwrap();
            let electron = format!(
                " $env:ELECTRON_RUN_AS_NODE = '1'; $payload | & '{}' '{hook}' claude",
                executable(platform)
            );
            assert!(js_script.ends_with(&electron), "{js_script}");
            let rust_script = js_script.replace(&electron, &format!(" $payload | & '{hook}' record claude"));
            assert_eq!(decode_command(encoded), rust_script);
            rust["hooks"]["SessionStart"][0]["hooks"][0]["command"] =
                format!("{prefix} -EncodedCommand {{{{ENCODED_COMMAND}}}}").into();
        } else {
            let electron = format!("ELECTRON_RUN_AS_NODE=1 '{}' '{hook}' claude", executable(platform));
            assert_eq!(hook_command(expected), electron);
            assert_eq!(command, format!("'{hook}' record claude"));
            rust["hooks"]["SessionStart"][0]["hooks"][0]["command"] = electron.into();
        }
        assert_eq!(&rust, expected, "{platform}: everything but the command is unchanged");
    }
    assert_eq!(
        claude_hook_command("/opt/it's/tc-hook", false),
        "'/opt/it'\\''s/tc-hook' record claude"
    );
}

/// The Electron executable the capture script passed to `prepareIntegration`.
fn executable(platform: &str) -> String {
    golden_json("integration.json")["executables"][platform]
        .as_str()
        .unwrap()
        .to_owned()
}

fn decode_command(encoded: &str) -> String {
    let bytes = tc_core::node::base64_decode(encoded);
    let units: Vec<u16> = bytes
        .chunks(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    String::from_utf16(&units).unwrap()
}

fn temp_folder() -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("tc-integration-{nanos}"))
}

/// The files and arguments `prepareIntegration` produced, with the documented differences:
/// no `TC_NODE`, because `tc-hook` is a native executable.
#[test]
fn integration_files_match_prepare_integration() {
    let golden = golden_json("integration.json");
    for case in golden["integration"].as_array().unwrap() {
        let platform = Platform::from_node(case["platform"].as_str().unwrap());
        let shell = case["shell"].as_str().unwrap();
        let folder = temp_folder();
        let hook = Path::new("/opt/terminal-canvas/tc-hook");
        let prepared = prepare(&folder, hook, platform, shell).unwrap();
        let expected = &case["result"];
        let Some(integration) = prepared else {
            assert!(expected.is_null(), "{shell}");
            continue;
        };
        let stem = integration
            .session_file
            .file_stem()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let mut files: Vec<String> = std::fs::read_dir(&folder)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy()[stem.len()..].to_owned())
            .collect();
        files.sort();
        assert_eq!(Value::from(files), expected["files"], "{shell}");
        let script = folder.join(format!(
            "{stem}{}",
            if platform.is_windows() { ".ps1" } else { ".bash" }
        ));
        let settings = folder.join(format!("{stem}.settings.json"));
        let source = std::fs::read_to_string(&script).unwrap();
        let settings_text = settings.to_string_lossy();
        let expected_source = if platform.is_windows() {
            powershell_source(&settings_text)
        } else {
            bash_source(&settings_text)
        };
        assert_eq!(source, expected_source);
        let args = integration.args.clone().map(|mut args| {
            if platform.is_windows() {
                assert_eq!(args.last().map(|encoded| decode_command(encoded)), Some(source.clone()));
                *args.last_mut().unwrap() = "{{ENCODED_SCRIPT}}".into();
            }
            args
        });
        assert_eq!(serde_json::to_value(&args).unwrap(), expected["args"], "{shell}");
        let command = integration
            .command
            .as_deref()
            .map(|command| command.replace(&*script.to_string_lossy(), "{{SCRIPT}}"));
        assert_eq!(serde_json::to_value(command).unwrap(), expected["command"], "{shell}");
        let env: Vec<&str> = integration.env.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(env, ["TC_SESSION_FILE", "TC_HOOK"]);
        assert_eq!(integration.env[1].1, hook.to_string_lossy());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for file in [&script, &settings] {
                assert_eq!(std::fs::metadata(file).unwrap().permissions().mode() & 0o777, 0o600);
            }
            assert_eq!(std::fs::metadata(&folder).unwrap().permissions().mode() & 0o777, 0o700);
        }
        std::fs::write(&integration.session_file, "{}").unwrap();
        integration.cleanup();
        assert_eq!(
            std::fs::read_dir(&folder).unwrap().count(),
            0,
            "cleanup removes every file"
        );
        std::fs::remove_dir(&folder).unwrap();
    }
}
