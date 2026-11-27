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

/// Three terminals on the first canvas, so a split has room to be wrong.
fn split_board() -> Value {
    let mut raw = multiple();
    let extra: Vec<_> = (0..2).map(|_| create_card(&json!({})).unwrap()).collect();
    for card in &extra {
        raw["cards"].as_array_mut().unwrap().push(json!(card));
        raw["canvases"][0]["cardIds"]
            .as_array_mut()
            .unwrap()
            .push(json!(card.id));
    }
    let ids = raw["canvases"][0]["cardIds"].clone();
    raw["canvases"][0]["focused"] = ids[1].clone();
    raw["canvases"][0]["split"] =
        json!({ "cardIds": [ids[1], ids[0], ids[2]], "orientation": "column", "sizes": [0.25, 0.5, 0.25] });
    raw
}

#[test]
fn splits_roundtrip_after_focus_and_survive_recovery() {
    let raw = split_board();
    let board = validate_workspace(&raw).unwrap();
    let split = board.canvases[0].split.as_ref().unwrap();
    assert_eq!(split.orientation, tc_core::workspace::SplitOrientation::Column);
    assert_eq!(split.sizes, [0.25, 0.5, 0.25]);
    assert_eq!(board.to_value(), raw, "the same JSON, with the split last");
    let file: Value = serde_json::from_str(&board.to_file_string(None)).unwrap();
    assert_eq!(
        file["canvases"][0].as_object().unwrap().keys().collect::<Vec<_>>(),
        ["id", "name", "camera", "cardIds", "itemIds", "focused", "split"]
    );
    let mut whole = raw.clone();
    whole["canvases"][0]["split"]["sizes"] = json!([1, 1, 0.5]);
    let saved: Value = serde_json::from_str(&validate_workspace(&whole).unwrap().to_file_string(None)).unwrap();
    // `1` and `1.0` are different JSON numbers here: whole shares are written as the renderer wrote them.
    assert_eq!(saved["canvases"][0]["split"]["sizes"], json!([1, 1, 0.5]));
    let mut recovery = WorkspaceRecovery::new();
    recovery.accept(&raw).unwrap();
    assert_eq!(recovery.persist(Some(&raw)).unwrap(), board);
    assert!(
        validate_workspace(&multiple())
            .unwrap()
            .canvases
            .iter()
            .all(|canvas| canvas.split.is_none())
    );
}

#[test]
fn split_validation_rejects_wrong_members_orientation_and_shares() {
    let valid = split_board();
    let mutations: [fn(&mut Value); 12] = [
        |raw| raw["canvases"][0]["split"] = json!("row"),
        |raw| raw["canvases"][0]["split"]["cardIds"] = json!([raw["canvases"][0]["cardIds"][0]]),
        |raw| raw["canvases"][0]["split"]["cardIds"] = json!(["a", "b", "c", "d", "e"]),
        |raw| raw["canvases"][0]["split"]["cardIds"][1] = raw["canvases"][0]["split"]["cardIds"][0].clone(),
        |raw| raw["canvases"][0]["split"]["cardIds"][2] = raw["canvases"][1]["cardIds"][0].clone(),
        |raw| raw["canvases"][0]["split"]["cardIds"][0] = json!("not an id!"),
        |raw| raw["canvases"][0]["split"]["orientation"] = json!("diagonal"),
        |raw| {
            raw["canvases"][0]["split"]
                .as_object_mut()
                .unwrap()
                .shift_remove("orientation");
        },
        |raw| raw["canvases"][0]["split"]["sizes"] = json!([0.5, 0.5]),
        |raw| raw["canvases"][0]["split"]["sizes"][0] = json!(0),
        |raw| raw["canvases"][0]["split"]["sizes"][0] = json!(1.5),
        |raw| raw["canvases"][0]["split"]["sizes"][0] = json!("0.5"),
    ];
    for (index, mutate) in mutations.iter().enumerate() {
        let mut raw = valid.clone();
        mutate(&mut raw);
        assert_eq!(
            validate_workspace(&raw).unwrap_err().to_string(),
            "Invalid canvas split.",
            "case {index}"
        );
    }
    // Earlier checks keep their precedence over a broken split.
    let mut raw = valid.clone();
    raw["canvases"][0]["split"]["orientation"] = json!("diagonal");
    raw["canvases"][0]["focused"] = valid["cards"][1]["id"].clone();
    assert_eq!(
        validate_workspace(&raw).unwrap_err().to_string(),
        "Invalid canvas focus."
    );
    let mut raw = valid;
    raw["canvases"][0]["split"] = Value::Null;
    assert!(validate_workspace(&raw).unwrap().canvases[0].split.is_none());
}

/// Three terminals of the first canvas pinned beside it: one above two side by side.
fn dock_board() -> Value {
    let mut raw = split_board();
    let ids = raw["canvases"][0]["cardIds"].clone();
    raw["canvases"][0]["dock"] = json!({ "width": 0.35, "layout": {
        "orientation": "column", "sizes": [0.4, 0.6],
        "children": [{ "cardId": ids[0] }, { "orientation": "row", "children": [{ "cardId": ids[1] }, { "cardId": ids[2] }], "sizes": [1, 0.25] }]
    } });
    raw
}

/// A dock nested `depth` splits deep, each split holding a terminal and the next split.
fn nested_dock(raw: &mut Value, depth: usize) {
    let mut cards = Vec::new();
    for _ in 0..=depth {
        let card = create_card(&json!({})).unwrap();
        raw["cards"].as_array_mut().unwrap().push(json!(card));
        raw["canvases"][1]["cardIds"]
            .as_array_mut()
            .unwrap()
            .push(json!(card.id));
        cards.push(card.id);
    }
    let mut layout = json!({ "cardId": cards.pop().unwrap() });
    while let Some(id) = cards.pop() {
        layout = json!({ "orientation": "row", "children": [{ "cardId": id }, layout], "sizes": [0.5, 0.5] });
    }
    raw["canvases"][1]["dock"] = json!({ "width": 0.5, "layout": layout });
}

#[test]
fn docks_roundtrip_last_and_survive_recovery() {
    let raw = dock_board();
    let board = validate_workspace(&raw).unwrap();
    let dock = board.canvases[0].dock.as_ref().unwrap();
    assert_eq!(dock.width, 0.35);
    assert!(matches!(&dock.layout, tc_core::workspace::DockNode::Split { children, .. } if children.len() == 2));
    let file: Value = serde_json::from_str(&board.to_file_string(None)).unwrap();
    assert_eq!(
        file["canvases"][0].as_object().unwrap().keys().collect::<Vec<_>>(),
        ["id", "name", "camera", "cardIds", "itemIds", "focused", "split", "dock"]
    );
    // Nodes keep the renderer's key order, and whole shares are written without a decimal point.
    let layout = &file["canvases"][0]["dock"]["layout"];
    assert_eq!(
        layout.as_object().unwrap().keys().collect::<Vec<_>>(),
        ["orientation", "children", "sizes"]
    );
    assert_eq!(layout["children"][1]["sizes"], json!([1, 0.25]));
    assert_eq!(file["canvases"][0]["dock"], raw["canvases"][0]["dock"]);
    let mut recovery = WorkspaceRecovery::new();
    recovery.accept(&raw).unwrap();
    assert_eq!(recovery.persist(Some(&raw)).unwrap(), board);
    let mut single = multiple();
    let id = single["canvases"][0]["cardIds"][0].clone();
    single["canvases"][0]["dock"] = json!({ "width": 0.05, "layout": { "cardId": id } });
    assert_eq!(validate_workspace(&single).unwrap().to_value(), single);
}

#[test]
fn docks_nest_up_to_the_depth_limit() {
    let mut raw = multiple();
    nested_dock(&mut raw, tc_core::workspace::DOCK_DEPTH);
    validate_workspace(&raw).unwrap();
    let mut raw = multiple();
    nested_dock(&mut raw, tc_core::workspace::DOCK_DEPTH + 1);
    assert_eq!(
        validate_workspace(&raw).unwrap_err().to_string(),
        "Invalid canvas dock."
    );
}

#[test]
fn dock_validation_rejects_wrong_width_members_and_shapes() {
    let valid = dock_board();
    let mutations: [fn(&mut Value); 13] = [
        |raw| raw["canvases"][0]["dock"]["width"] = json!(0.96),
        |raw| raw["canvases"][0]["dock"]["width"] = json!(0.04),
        |raw| {
            raw["canvases"][0]["dock"]
                .as_object_mut()
                .unwrap()
                .shift_remove("layout");
        },
        |raw| raw["canvases"][0]["dock"]["layout"] = json!([]),
        |raw| raw["canvases"][0]["dock"]["layout"]["children"][0]["cardId"] = raw["canvases"][1]["cardIds"][0].clone(),
        |raw| raw["canvases"][0]["dock"]["layout"]["children"][0]["cardId"] = raw["canvases"][0]["cardIds"][1].clone(),
        |raw| raw["canvases"][0]["dock"]["layout"]["children"][0]["cardId"] = json!(7),
        |raw| raw["canvases"][0]["dock"]["layout"]["orientation"] = json!("grid"),
        |raw| {
            raw["canvases"][0]["dock"]["layout"]["children"] = json!([{ "cardId": raw["canvases"][0]["cardIds"][0] }])
        },
        |raw| raw["canvases"][0]["dock"]["layout"]["sizes"] = json!([0.5]),
        |raw| raw["canvases"][0]["dock"]["layout"]["sizes"][0] = json!(0),
        |raw| raw["canvases"][0]["dock"]["layout"]["sizes"][0] = json!(1.01),
        |raw| raw["canvases"][0]["dock"] = json!("left"),
    ];
    for (index, mutate) in mutations.iter().enumerate() {
        let mut raw = valid.clone();
        mutate(&mut raw);
        assert_eq!(
            validate_workspace(&raw).unwrap_err().to_string(),
            "Invalid canvas dock.",
            "case {index}"
        );
    }
    // A broken split view is reported before a broken dock.
    let mut raw = valid.clone();
    raw["canvases"][0]["dock"]["width"] = json!(2);
    raw["canvases"][0]["split"]["orientation"] = json!("diagonal");
    assert_eq!(
        validate_workspace(&raw).unwrap_err().to_string(),
        "Invalid canvas split."
    );
    let mut raw = valid;
    raw["canvases"][0]["dock"] = Value::Null;
    assert!(validate_workspace(&raw).unwrap().canvases[0].dock.is_none());
}
