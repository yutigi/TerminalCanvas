//! Image asset handling matches the JavaScript host.

mod common;

use std::fs;

use common::{TempDir, assert_json, assert_outcome, load, strings};
use serde_json::{Value, json};
use tc_core::assets::{
    IMAGE_BYTES, StoredAsset, asset_path, delete_assets, detect_image, embed_assets, extract_assets, image_names,
    keep_list, store_image, unused_assets,
};
use tc_core::workspace::{Item, ItemKind, Rect, create_workspace};

fn from_hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
        .collect()
}

fn bytes(spec: &Value) -> Vec<u8> {
    match spec.get("hex") {
        Some(hex) => from_hex(hex.as_str().expect("hex")),
        None => {
            from_hex(spec["repeat"].as_str().expect("repeat")).repeat(spec["count"].as_u64().expect("count") as usize)
        }
    }
}

/// A workspace holding the fixture's image items, which are the only items these functions read.
fn board(raw: &Value) -> tc_core::workspace::Workspace {
    let mut board = create_workspace();
    let rect = Rect {
        x: 0.0,
        y: 0.0,
        w: 10.0,
        h: 10.0,
    };
    for (index, item) in raw
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        if item["type"] == "image" {
            let asset = item["asset"].as_str().expect("fixture assets are strings").to_owned();
            board.items.push(Item {
                id: format!("i{index}"),
                kind: ItemKind::Image { rect, asset },
                color: None,
                font_size: None,
                groups: Vec::new(),
            });
        }
    }
    board
}

#[test]
fn detection_and_names_match() {
    let golden = load("assets.json");
    assert_eq!(golden["imageBytes"], IMAGE_BYTES);
    for case in golden["detectImage"].as_array().expect("detectImage") {
        let result =
            detect_image(&bytes(&case["bytes"])).map(|image| json!({ "ext": image.as_str(), "mime": image.mime() }));
        assert_outcome(result, case, case["name"].as_str().expect("name"));
    }
    for case in golden["assetNames"].as_array().expect("assetNames") {
        let result = match case["name"].as_str() {
            Some(name) => asset_path(std::path::Path::new("/assets"), name).map(|_| true),
            None => Err(tc_core::Error::Invalid("Invalid image asset.".into())),
        };
        assert_outcome(result, case, &case["name"].to_string());
    }
    for case in golden["imageNames"].as_array().expect("imageNames") {
        assert_json(
            &json!(image_names(&board(&case["board"]))),
            &case["names"],
            &case["board"].to_string(),
        );
    }
}

#[test]
fn storing_matches() {
    let golden = load("assets.json");
    let dir = TempDir::new("store");
    for case in golden["storeImage"].as_array().expect("storeImage") {
        let name = store_image(&dir.0, &from_hex(case["bytes"].as_str().expect("bytes"))).unwrap();
        assert_eq!(name, case["name"].as_str().expect("name"));
    }
    assert_eq!(dir.listing(), strings(&golden["stored"]));
}

#[test]
fn keep_lists_match() {
    let golden = load("assets.json");
    for case in golden["keepList"].as_array().expect("keepList") {
        let result = keep_list(&case["input"]).map(|keep| {
            let mut names: Vec<String> = keep.into_iter().collect();
            names.sort();
            names
        });
        let mut case = case.clone();
        if let Some(Value::Array(names)) = case.get_mut("result") {
            names.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
        }
        let label = format!("keep list of {} names", case["input"].as_array().map_or(0, Vec::len));
        assert_outcome(result, &case, &label);
    }
}

#[test]
fn extraction_matches() {
    let golden = load("assets.json");
    for case in golden["extractAssets"].as_array().expect("extractAssets") {
        let name = case["name"].as_str().expect("name");
        let dir = TempDir::new("extract");
        assert_outcome(extract_assets(case["input"].clone(), &dir.0), case, name);
        assert_eq!(dir.listing(), strings(&case["stored"]), "{name}: stored files");
    }
}

#[test]
fn embedding_matches() {
    let golden = load("assets.json");
    for case in golden["embedAssets"].as_array().expect("embedAssets") {
        let dir = TempDir::new("embed");
        for file in case["files"].as_array().expect("files") {
            fs::write(
                dir.0.join(file["name"].as_str().expect("name")),
                from_hex(file["hex"].as_str().expect("hex")),
            )
            .unwrap();
        }
        let embedded = embed_assets(&board(&case["board"]), &dir.0);
        assert_json(
            &serde_json::to_value(embedded).unwrap(),
            &case["result"],
            case["name"].as_str().expect("name"),
        );
    }
}

#[test]
fn cleanup_matches() {
    let golden = load("assets.json");
    for case in golden["cleanup"].as_array().expect("cleanup") {
        let name = case["name"].as_str().expect("name");
        let root = TempDir::new("cleanup");
        let dir = if case["files"].is_null() {
            root.0.join("missing")
        } else {
            root.0.clone()
        };
        for file in case["files"].as_array().into_iter().flatten() {
            let path = dir.join(file["name"].as_str().expect("name"));
            if file["directory"] == true {
                fs::create_dir(&path).unwrap();
                if let Some(child) = file["child"].as_str() {
                    fs::write(path.join(child), "x").unwrap();
                }
            } else {
                fs::write(&path, from_hex(file["hex"].as_str().expect("hex"))).unwrap();
            }
        }
        let keep = keep_list(&case["keep"]).unwrap();
        let unused = unused_assets(&dir, &keep).unwrap();
        assert_json(
            &serde_json::to_value(&unused).unwrap(),
            &case["unused"],
            &format!("{name}: unused"),
        );
        let mut targets = unused;
        targets.push(StoredAsset {
            name: format!("{}.png", "b".repeat(64)),
            bytes: 99,
        });
        assert_json(
            &serde_json::to_value(delete_assets(&dir, &targets)).unwrap(),
            &case["deleted"],
            &format!("{name}: deleted"),
        );
        assert_eq!(common::listing(&dir), strings(&case["remaining"]), "{name}: remaining");
    }
}
