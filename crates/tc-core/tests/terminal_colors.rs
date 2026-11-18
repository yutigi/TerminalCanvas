mod common;

use serde_json::{Value, json};
use tc_core::styles::{Color, TerminalTheme};
use tc_core::workspace::{VERSION, create_card, create_workspace, validate_card, validate_workspace};

#[test]
fn terminal_style_fixture_roundtrips_files_and_portable_exports() {
    let fixture = common::load("terminal-styles.json");
    let board = validate_workspace(&fixture).unwrap();
    assert_eq!(board.to_value(), fixture);
    let assets = serde_json::Map::from_iter([("example.png".into(), json!("embedded bytes"))]);
    for embedded in [None, Some(&assets)] {
        let saved: Value = serde_json::from_str(&board.to_file_string(embedded)).unwrap();
        assert_eq!(validate_workspace(&saved).unwrap(), board);
        if embedded.is_some() {
            assert_eq!(saved["assets"], json!(assets));
        }
    }
}

#[test]
fn terminal_colors_and_theme_overrides_validate_and_clear() {
    let raw = json!(create_card(&json!({})).unwrap());
    for color in Color::ALL {
        for theme in TerminalTheme::ALL {
            let mut card = raw.clone();
            card["color"] = json!(color);
            card["theme"] = json!(theme);
            let checked = validate_card(&card, VERSION).unwrap();
            assert_eq!(checked.color, Some(*color));
            assert_eq!(checked.theme, Some(*theme));
            assert_eq!(json!(checked), card);
        }
    }
    for color in [Value::Null, json!("default")] {
        let mut card = raw.clone();
        card["color"] = color;
        card["theme"] = Value::Null;
        assert_eq!(json!(validate_card(&card, VERSION).unwrap()), raw);
    }
    for invalid in [
        json!("unknown"),
        json!(""),
        json!("PAPER"),
        json!(3),
        json!([]),
        json!({}),
        json!(false),
    ] {
        let mut card = raw.clone();
        card["theme"] = invalid.clone();
        assert_eq!(
            validate_card(&card, VERSION).unwrap_err().to_string(),
            "Unsupported terminal theme."
        );
        card.as_object_mut().unwrap().shift_remove("theme");
        card["color"] = invalid;
        assert_eq!(
            validate_card(&card, VERSION).unwrap_err().to_string(),
            "Unsupported item color."
        );
        card["w"] = json!(0);
        assert_eq!(
            validate_card(&card, VERSION).unwrap_err().to_string(),
            "Invalid card size."
        );
    }
}

#[test]
fn workspace_defaults_are_optional_and_legacy_workspaces_keep_their_look() {
    let original = create_workspace().to_value();
    for version in [1, 2, 3] {
        let mut board = original.clone();
        board["version"] = json!(version);
        board["cards"] = json!([create_card(&json!({})).unwrap()]);
        let checked = validate_workspace(&board).unwrap();
        assert_eq!(checked.terminal_theme, None);
        assert_eq!(checked.cards[0].color, None);
        assert_eq!(checked.cards[0].theme, None);
        assert!(checked.to_value().get("terminalTheme").is_none());
        assert_eq!(checked.to_value()["version"], VERSION);
    }
    for theme in TerminalTheme::ALL {
        let mut board = original.clone();
        board["terminalTheme"] = json!(theme);
        let checked = validate_workspace(&board).unwrap();
        assert_eq!(
            checked.terminal_theme,
            (*theme != TerminalTheme::Current).then_some(*theme)
        );
    }
    for theme in [Value::Null, json!("current")] {
        let mut board = original.clone();
        board["terminalTheme"] = theme;
        assert_eq!(validate_workspace(&board).unwrap().to_value(), original);
    }
    let mut bad = original;
    bad["terminalTheme"] = json!("unknown");
    assert_eq!(
        validate_workspace(&bad).unwrap_err().to_string(),
        "Unsupported terminal theme."
    );
    bad["camera"]["z"] = json!(0);
    assert_eq!(
        validate_workspace(&bad).unwrap_err().to_string(),
        "Invalid canvas camera."
    );
}
