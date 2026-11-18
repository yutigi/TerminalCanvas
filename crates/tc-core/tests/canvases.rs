//! Canvas organization extends format 3 without changing legacy files or host metadata authority.
use serde_json::{Value, json};
use tc_core::recovery::{CardMetadata, WorkspaceRecovery};
use tc_core::session::{Provider, SessionMetadata};
use tc_core::workspace::{create_card, create_workspace, validate_workspace};

fn canvas(id: &str, cards: Value, items: Value) -> Value {
    json!({ "id": id, "name": id, "camera": { "x": 12, "y": -30, "z": 0.75 }, "cardIds": cards, "itemIds": items })
}

fn multiple() -> Value {
    let mut raw = create_workspace().to_value();
    let first = create_card(&json!({ "title": "Foreground" })).unwrap();
    let second = create_card(&json!({ "title": "Background" })).unwrap();
    raw["canvases"] = json!([
        canvas("first", json!([first.id]), json!([])),
        canvas("second", json!([second.id]), json!([]))
    ]);
    raw["activeCanvas"] = json!("first");
    raw["cards"] = json!([first, second]);
    raw
}

#[test]
fn canvas_recovery_keeps_workspace_theme_and_hidden_terminal_styles() {
    let mut raw = multiple();
    raw["terminalTheme"] = json!("midnight");
    raw["cards"][1]["color"] = json!("red");
    raw["cards"][1]["theme"] = json!("current");
    let mut recovery = WorkspaceRecovery::new();
    recovery.accept(&raw).unwrap();
    let saved = recovery.persist(Some(&raw)).unwrap();
    assert_eq!(saved.to_value(), raw);
    assert_eq!(validate_workspace(&saved.to_value()).unwrap(), saved);
    raw["canvases"] = json!([]);
    raw["terminalTheme"] = json!("invalid");
    assert_eq!(
        validate_workspace(&raw).unwrap_err().to_string(),
        "Unsupported terminal theme."
    );
}

#[test]
fn many_canvases_roundtrip_without_a_fixed_count_limit() {
    let mut raw = create_workspace().to_value();
    raw["canvases"] = (0..4096)
        .map(|index| canvas(&format!("canvas-{index}"), json!([]), json!([])))
        .collect();
    raw["activeCanvas"] = json!("canvas-4095");
    let board = validate_workspace(&raw).unwrap();
    assert_eq!(board.canvases.len(), 4096);
    assert_eq!(board.active_canvas.as_deref(), Some("canvas-4095"));
    let saved: Value = serde_json::from_str(&board.to_file_string(None)).unwrap();
    assert_eq!(saved["version"], 3);
    assert_eq!(validate_workspace(&saved).unwrap(), board);
}

#[test]
fn legacy_formats_keep_their_original_serialized_defaults() {
    for version in [1, 2, 3] {
        let mut raw = create_workspace().to_value();
        raw["version"] = json!(version);
        raw["cards"] = json!([create_card(&json!({ "cwd": "/project" })).unwrap()]);
        let board = validate_workspace(&raw).unwrap();
        assert!(board.canvases.is_empty());
        assert!(board.active_canvas.is_none());
        raw["version"] = json!(3);
        assert_eq!(board.to_value(), raw);
    }
}

#[test]
fn recovery_retains_hidden_metadata_order_viewports_and_focus() {
    let mut raw = multiple();
    let hidden = raw["cards"][1]["id"].as_str().unwrap().to_owned();
    raw["canvases"][1]["name"] = json!("Background project 日本語");
    raw["canvases"][1]["focused"] = json!(hidden);
    raw["canvases"][1]["selected"] = json!(hidden);
    raw["activeCanvas"] = json!("second");
    let mut recovery = WorkspaceRecovery::new();
    recovery.accept(&raw).unwrap();
    let session = SessionMetadata {
        provider: Provider::Codex,
        session_id: "11111111-1111-4111-8111-111111111111".into(),
        cwd: "/agent".into(),
    };
    recovery
        .update(
            &hidden,
            CardMetadata {
                cwd: "/latest".into(),
                session: Some(session.clone()),
            },
        )
        .unwrap();
    raw["canvases"].as_array_mut().unwrap().reverse();
    let saved = recovery.persist(Some(&raw)).unwrap();
    assert_eq!(saved.cards[1].cwd, "/latest");
    assert_eq!(saved.cards[1].session, Some(session));
    assert_eq!(saved.canvases[0].id, "second");
    assert_eq!(saved.canvases[0].camera.z, 0.75);
    assert_eq!(saved.canvases[0].focused.as_deref(), Some(hidden.as_str()));
    let reopened = validate_workspace(&serde_json::from_str(&saved.to_file_string(None)).unwrap()).unwrap();
    assert_eq!(saved, reopened);
    let added = create_card(&json!({})).unwrap();
    recovery.remember_card(&json!(added)).unwrap();
    assert!(recovery.board().canvases[0].card_ids.contains(&added.id));
}

#[test]
fn canvas_validation_rejects_missing_duplicate_and_foreign_members() {
    let valid = multiple();
    for mutate in [
        |raw: &mut Value| raw["canvases"][1]["cardIds"] = json!([]),
        |raw: &mut Value| raw["canvases"][1]["cardIds"] = raw["canvases"][0]["cardIds"].clone(),
        |raw: &mut Value| raw["canvases"][1]["cardIds"] = json!(["unknown"]),
        |raw: &mut Value| raw["canvases"][1]["itemIds"] = raw["canvases"][1]["cardIds"].clone(),
    ] {
        let mut raw = valid.clone();
        mutate(&mut raw);
        assert_eq!(
            validate_workspace(&raw).unwrap_err().to_string(),
            "Invalid canvas ownership."
        );
    }
    let mut raw = valid.clone();
    raw["canvases"][1]["id"] = json!("first");
    assert_eq!(
        validate_workspace(&raw).unwrap_err().to_string(),
        "Duplicate canvas IDs."
    );
    let mut raw = valid.clone();
    raw["activeCanvas"] = json!("missing");
    assert_eq!(
        validate_workspace(&raw).unwrap_err().to_string(),
        "Invalid active canvas."
    );
    let mut raw = valid;
    raw["canvases"][1]["focused"] = raw["cards"][0]["id"].clone();
    assert_eq!(
        validate_workspace(&raw).unwrap_err().to_string(),
        "Invalid canvas focus."
    );
}

#[test]
fn names_keep_utf16_limits_and_legacy_validation_precedence() {
    let mut raw = multiple();
    raw["canvases"][0]["name"] = json!("😀".repeat(50));
    validate_workspace(&raw).unwrap();
    raw["canvases"][0]["name"] = json!("😀".repeat(51));
    assert_eq!(
        validate_workspace(&raw).unwrap_err().to_string(),
        "Invalid canvas name."
    );
    raw["camera"]["z"] = json!(0);
    assert_eq!(
        validate_workspace(&raw).unwrap_err().to_string(),
        "Invalid canvas camera."
    );
}

#[test]
fn groups_and_connectors_cannot_cross_canvas_boundaries() {
    let mut raw = multiple();
    raw["cards"][0]["groups"] = json!(["group"]);
    raw["cards"][1]["groups"] = json!(["group"]);
    assert_eq!(
        validate_workspace(&raw).unwrap_err().to_string(),
        "Groups cannot span canvases."
    );
    raw["cards"][0].as_object_mut().unwrap().shift_remove("groups");
    raw["cards"][1].as_object_mut().unwrap().shift_remove("groups");
    raw["items"] = json!([{ "id": "line", "type": "line", "start": { "id": raw["cards"][1]["id"] }, "end": { "x": 10, "y": 20 } }]);
    raw["canvases"][0]["itemIds"] = json!(["line"]);
    assert_eq!(
        validate_workspace(&raw).unwrap_err().to_string(),
        "Connectors cannot span canvases."
    );
    raw["canvases"][0]["itemIds"] = json!([]);
    raw["canvases"][1]["itemIds"] = json!(["line"]);
    validate_workspace(&raw).unwrap();
}
