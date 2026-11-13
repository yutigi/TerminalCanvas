//! Workspace validation matches the JavaScript host except its removed terminal-count limit.

mod common;

use common::{assert_json, assert_outcome, load};
use serde_json::{Value, json};
use tc_core::styles::{COLORED_TYPES, Color, FontSize, GROUP_DEPTH, TEXT_TYPES};
use tc_core::workspace::{
    self, ITEM_SIZE_MAX, ITEM_SIZE_MIN, ITEM_TYPES, PROFILES, Shape, VERSION, limits, validate_card, validate_item,
    validate_workspace,
};

fn names<T: Copy>(all: &[T], name: impl Fn(T) -> &'static str) -> Value {
    all.iter().map(|value| name(*value)).collect()
}

#[test]
fn renderer_fixtures_match_host_defaults_without_loading_javascript_host_code() {
    let golden = load("renderer.json");
    assert_json(&json!(PROFILES), &golden["profiles"], "renderer profiles");
    assert_json(
        &workspace::create_workspace().to_value(),
        &golden["workspace"],
        "empty renderer workspace",
    );
    for (profile, expected) in golden["cards"].as_object().unwrap() {
        let mut actual = json!(workspace::create_card(&json!({"profile":profile})).unwrap());
        actual["id"] = expected["id"].clone();
        assert_json(&actual, expected, profile);
    }
}

#[test]
fn constants_match() {
    let golden = load("workspace.json");
    let mut constants = golden["constants"].clone();
    // The frozen Electron oracle still records the old terminal-count limit.
    constants["LIMITS"].as_object_mut().unwrap().shift_remove("cards");
    let actual = json!({
        "VERSION": VERSION,
        "LIMITS": {
            "items": limits::ITEMS, "bytes": limits::BYTES, "coordinate": limits::COORDINATE,
            "text": limits::TEXT, "groupDepth": limits::GROUP_DEPTH
        },
        "PROFILES": PROFILES,
        "ITEM_TYPES": ITEM_TYPES,
        "SHAPES": names(Shape::ALL, Shape::as_str),
        "ITEM_SIZE": { "min": ITEM_SIZE_MIN, "max": ITEM_SIZE_MAX },
        "COLORS": names(Color::ALL, Color::as_str),
        "FONT_SIZES": names(FontSize::ALL, FontSize::as_str),
        "COLORED_TYPES": COLORED_TYPES,
        "TEXT_TYPES": TEXT_TYPES,
        "GROUP_DEPTH": GROUP_DEPTH,
        "createWorkspace": workspace::create_workspace(),
    });
    assert_json(&actual, &constants, "constants");
}

#[test]
fn validation_cases_match() {
    let golden = load("workspace.json");
    let cases = golden["cases"].as_array().expect("cases");
    assert!(cases.len() > 300, "the fixture covers every field");
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let input = &case["input"];
        if name == "workspace: 25 cards" {
            // This fully specified workspace is now accepted without changing its fields.
            assert_json(&validate_workspace(input).unwrap().to_value(), input, name);
            continue;
        }
        let version = case
            .get("version")
            .and_then(Value::as_u64)
            .map_or(VERSION, |v| v as u32);
        match case["fn"].as_str().expect("fn") {
            "validateWorkspace" => assert_outcome(validate_workspace(input), case, name),
            "validateCard" => assert_outcome(validate_card(input, version), case, name),
            "validateItem" => assert_outcome(validate_item(input, version), case, name),
            other => panic!("unknown function {other}"),
        }
    }
}

#[test]
fn larger_workspaces_migrate_roundtrip_and_still_validate_every_card() {
    for version in [1, 2, 3] {
        let mut board = workspace::create_workspace().to_value();
        board["version"] = json!(version);
        board["cards"] = (0..64)
            .map(|index| json!(workspace::create_card(&json!({ "title": format!("Terminal {index}") })).unwrap()))
            .collect();
        let validated = validate_workspace(&board).unwrap();
        assert_eq!(validated.cards.len(), 64);
        let saved: Value = serde_json::from_str(&validated.to_file_string(None)).unwrap();
        assert_eq!(saved["version"], VERSION);
        assert_eq!(validate_workspace(&saved).unwrap(), validated);

        board["cards"][24]["id"] = board["cards"][0]["id"].clone();
        assert_eq!(
            validate_workspace(&board).unwrap_err().to_string(),
            "Duplicate terminal IDs."
        );
    }
}

/// Applies `[path, value]` like the capture script: only to existing objects, `$delete` removes.
fn mutate(target: &mut Value, change: &Value, delete: &Value) {
    let path = change[0].as_array().expect("path");
    let value = &change[1];
    let mut node = target;
    for key in &path[..path.len() - 1] {
        let next = match (node, key) {
            (Value::Object(fields), Value::String(key)) => fields.get_mut(key),
            (Value::Array(items), Value::Number(index)) => items.get_mut(index.as_u64().expect("index") as usize),
            _ => None,
        };
        match next {
            Some(next @ (Value::Object(_) | Value::Array(_))) => node = next,
            _ => return,
        }
    }
    let Value::Object(fields) = node else { return };
    let key = path.last().and_then(Value::as_str).expect("final key");
    if value == delete {
        fields.shift_remove(key);
    } else {
        fields.insert(key.to_owned(), value.clone());
    }
}

#[test]
fn randomized_mutations_fail_on_the_same_check() {
    let golden = load("workspace-mutations.json");
    let delete = &golden["delete"];
    let cases = golden["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 400);
    for (index, case) in cases.iter().enumerate() {
        let mut input = golden["base"].clone();
        for change in case["mutations"].as_array().expect("mutations") {
            mutate(&mut input, change, delete);
        }
        assert_outcome(
            validate_workspace(&input),
            case,
            &format!("mutation case {index}: {}", case["mutations"]),
        );
    }
}
