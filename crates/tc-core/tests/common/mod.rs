//! Loads the golden fixtures in `tests/golden/`, written by `scripts/capture-golden.cjs`.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

pub fn golden_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/golden")
}

/// Reads a fixture file and expands its compact encodings.
pub fn load(name: &str) -> Value {
    let path = golden_dir().join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    expand(serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display())))
}

/// `{ "$text": [...] }` and `{ "$array": {...} }`, as documented in the capture script.
pub fn expand(value: Value) -> Value {
    match value {
        Value::Object(mut fields) if fields.len() == 1 && fields.contains_key("$text") => {
            let Some(Value::Array(parts)) = fields.remove("$text") else {
                panic!("$text needs an array")
            };
            let mut text = String::new();
            for part in parts {
                match part {
                    Value::String(literal) => text.push_str(&literal),
                    Value::Array(run) => {
                        let unit = run[0].as_str().expect("unit");
                        let count = run[1].as_u64().expect("count") as usize;
                        text.push_str(&unit.repeat(count));
                    }
                    other => panic!("bad $text part {other}"),
                }
            }
            Value::String(text)
        }
        Value::Object(mut fields) if fields.len() == 1 && fields.contains_key("$array") => {
            let Some(Value::Object(spec)) = fields.remove("$array") else {
                panic!("$array needs an object")
            };
            let template = expand(spec["template"].clone());
            let count = spec["count"].as_u64().expect("count") as usize;
            let prefix = spec.get("idPrefix").and_then(Value::as_str);
            Value::Array(
                (0..count)
                    .map(|index| match (prefix, &template) {
                        (Some(prefix), Value::Object(template)) => {
                            let mut element = Map::new();
                            element.insert("id".to_owned(), Value::String(format!("{prefix}{index}")));
                            element.extend(template.clone());
                            Value::Object(element)
                        }
                        _ => template.clone(),
                    })
                    .collect(),
            )
        }
        Value::Object(fields) => Value::Object(fields.into_iter().map(|(key, value)| (key, expand(value))).collect()),
        Value::Array(items) => Value::Array(items.into_iter().map(expand).collect()),
        other => other,
    }
}

/// Numbers compare by value: the JavaScript host wrote `48` where serde may hold `48.0`.
pub fn normalize(value: &Value) -> Value {
    match value {
        Value::Number(n) => Value::from(n.as_f64().expect("finite")),
        Value::Array(items) => Value::Array(items.iter().map(normalize).collect()),
        Value::Object(fields) => Value::Object(fields.iter().map(|(k, v)| (k.clone(), normalize(v))).collect()),
        other => other.clone(),
    }
}

#[track_caller]
pub fn assert_json(actual: &Value, expected: &Value, context: &str) {
    assert!(
        normalize(actual) == normalize(expected),
        "{context}\n  actual:   {actual}\n  expected: {expected}"
    );
}

/// Compares a Rust result with a fixture's `{ "result": ... }` or `{ "error": "..." }`.
#[track_caller]
pub fn assert_outcome<T: serde::Serialize, E: std::fmt::Display>(actual: Result<T, E>, case: &Value, context: &str) {
    match (actual, case.get("result"), case.get("error")) {
        (Ok(value), Some(expected), _) => {
            assert_json(&serde_json::to_value(value).expect("serializes"), expected, context)
        }
        (Err(error), _, Some(expected)) => {
            assert_eq!(Value::String(error.to_string()), *expected, "{context}")
        }
        (Ok(value), _, Some(expected)) => {
            panic!(
                "{context}\n  expected error {expected}\n  got {}",
                serde_json::to_string(&value).unwrap()
            )
        }
        (Err(error), Some(expected), _) => panic!("{context}\n  expected {expected}\n  got error {error}"),
        _ => panic!("{context}: fixture has neither result nor error"),
    }
}

pub fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .expect("array")
        .iter()
        .map(|v| v.as_str().expect("string").to_owned())
        .collect()
}

/// A fresh empty folder, removed when dropped.
pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new(label: &str) -> Self {
        let path = std::env::temp_dir()
            .join(format!("tc-core-{label}-{}", std::process::id()))
            .join(format!("{:x}", rand_suffix()));
        std::fs::create_dir_all(&path).unwrap();
        TempDir(path)
    }

    pub fn listing(&self) -> Vec<String> {
        listing(&self.0)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub fn listing(path: &Path) -> Vec<String> {
    let mut names: Vec<String> = match std::fs::read_dir(path) {
        Ok(entries) => entries
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect(),
        Err(_) => Vec::new(),
    };
    names.sort();
    names
}

fn rand_suffix() -> u128 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    nanos ^ u128::from(NEXT.fetch_add(1, Ordering::Relaxed)) << 64
}
