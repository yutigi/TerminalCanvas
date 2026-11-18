use serde_json::{Value, json};
use tc_core::pointers::{self, Report};
use tc_core::workspace::{create_card, create_workspace, validate_workspace};

fn hook() -> Value {
    json!({"event":"stop","action":"prompt","text":"Review the change","armed":true})
}
fn board() -> Value {
    let mut board = create_workspace().to_value();
    board["cards"] = json!([
        create_card(&json!({})).unwrap(),
        create_card(&json!({})).unwrap(),
        create_card(&json!({})).unwrap()
    ]);
    board["items"] = json!([{"id":"p", "type":"line", "start":{"id":board["cards"][0]["id"]}, "end":{"id":board["cards"][1]["id"]}, "arrow":true, "hook":hook()}]);
    board
}

#[test]
fn optional_fields_roundtrip_without_changing_legacy_defaults() {
    let old = create_workspace().to_value();
    assert!(old.get("hooksPaused").is_none());
    for version in [1, 2, 3] {
        let mut raw = board();
        raw["version"] = json!(version);
        if version == 1 {
            raw["items"] = json!([]);
        }
        raw["hooksPaused"] = json!(true);
        let saved = validate_workspace(&raw).unwrap();
        assert_eq!(
            saved,
            validate_workspace(&serde_json::from_str(&saved.to_file_string(None)).unwrap()).unwrap()
        );
        assert!(saved.hooks_paused);
    }
}

#[test]
fn configuration_rejects_control_sequences_bad_types_and_utf16_overflow() {
    for (field, value) in [
        ("event", json!("output")),
        ("action", json!("exec")),
        ("armed", json!(1)),
        ("text", json!("\u{1b}[200~attack")),
        ("text", json!("😀".repeat(1001))),
        ("text", json!("  ")),
        ("filter", json!("success")),
        ("name", json!("not-on-stop")),
        ("context", json!("yes")),
        ("extra", json!(true)),
    ] {
        let mut raw = hook();
        raw[field] = value;
        assert!(pointers::validate(&raw).is_err(), "{raw}");
    }
    let mut raw = hook();
    raw["text"] = json!("😀".repeat(1000));
    assert!(pointers::validate(&raw).is_ok());
    raw["action"] = json!("shell");
    raw["text"] = json!("echo one\necho two");
    assert!(pointers::validate(&raw).is_err());
    raw["action"] = json!("prompt");
    assert!(pointers::validate(&raw).is_ok());
}

#[test]
fn only_terminal_arrows_are_pointers_and_all_cycles_are_rejected() {
    let mut raw = board();
    raw["items"][0]["arrow"] = json!(false);
    assert_eq!(
        validate_workspace(&raw).unwrap_err().to_string(),
        "Hook pointers need a terminal-to-terminal arrow."
    );
    raw = board();
    raw["items"][0]["end"] = raw["items"][0]["start"].clone();
    assert_eq!(
        validate_workspace(&raw).unwrap_err().to_string(),
        "Hook pointers cannot form a cycle."
    );
    raw = board();
    let mut back = raw["items"][0].clone();
    back["id"] = json!("back");
    back["start"] = raw["items"][0]["end"].clone();
    back["end"] = raw["items"][0]["start"].clone();
    back["hook"]["armed"] = json!(false);
    raw["items"].as_array_mut().unwrap().push(back);
    assert_eq!(
        validate_workspace(&raw).unwrap_err().to_string(),
        "Hook pointers cannot form a cycle."
    );
    raw["items"][1]["end"]["id"] = raw["cards"][2]["id"].clone();
    assert!(validate_workspace(&raw).is_ok(), "a three-terminal chain is valid");
    raw["items"][0]["hook"] = Value::Null;
    assert!(validate_workspace(&raw).unwrap().items[0].hook.is_none());
}

#[test]
fn event_filters_and_explicit_names_are_exact_and_context_is_only_prompt_data() {
    let mut report = Report {
        kind: "trigger".into(),
        name: "done".into(),
        token: String::new(),
        provider: String::new(),
        session_id: String::new(),
        message: "hello".into(),
        exit_code: Some(7),
        stop_hook_active: false,
        expires: pointers::now_ms() + 2000,
    };
    let mut config = hook();
    config["event"] = json!("trigger");
    config["name"] = json!("done");
    let mut pointer = pointers::validate(&config).unwrap();
    assert!(pointer.matches(&report));
    report.name = "other".into();
    assert!(!pointer.matches(&report));
    pointer.name.clear();
    assert!(pointer.matches(&report));
    pointer.armed = false;
    assert!(!pointer.matches(&report));
    config["event"] = json!("exit");
    config["name"] = json!("");
    config["filter"] = json!("failure");
    config["context"] = json!(true);
    let pointer = pointers::validate(&config).unwrap();
    report.kind = "exit".into();
    assert!(pointer.matches(&report));
    assert!(pointer.payload(&report).contains("Exit code: 7"));
    report.exit_code = Some(0);
    assert!(!pointer.matches(&report));
    report.exit_code = None;
    assert!(!pointer.matches(&report));
    config["action"] = json!("shell");
    assert!(pointers::validate(&config).is_err());
}

#[test]
fn private_transport_claims_once_and_rejects_expired_oversized_and_untrusted_metadata() {
    let folder = std::env::temp_dir().join(format!("tc-pointer-core-{}", uuid::Uuid::new_v4()));
    tc_core::launch::create_inbox(&folder, true).unwrap();
    let mut report = Report {
        kind: "trigger".into(),
        name: "done".into(),
        token: String::new(),
        provider: String::new(),
        session_id: String::new(),
        message: String::new(),
        exit_code: None,
        stop_hook_active: false,
        expires: pointers::now_ms() + 2000,
    };
    let (id, _) = pointers::write_request(&folder, &report).unwrap();
    let taken = pointers::take(&folder);
    assert_eq!(taken, [(id, report.clone())]);
    assert!(pointers::take(&folder).is_empty());
    report.expires = 1;
    let (expired, _) = pointers::write_request(&folder, &report).unwrap();
    assert!(pointers::take(&folder).is_empty());
    assert!(pointers::answer_path(&folder, &expired).is_file());
    std::fs::write(folder.join("big.hook"), vec![b'x'; 17000]).unwrap();
    assert!(pointers::take(&folder).is_empty());
    assert!(pointers::answer(&folder, "../outside", &json!({})).is_err());
    report.expires = pointers::now_ms() + 2000;
    report.kind = "stop".into();
    assert!(!report.valid());
    report.provider = "claude".into();
    report.message = "\u{1b}attack".into();
    assert!(!report.valid());
    std::fs::remove_dir_all(folder).unwrap();
}
