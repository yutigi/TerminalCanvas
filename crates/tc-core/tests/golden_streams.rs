//! Terminal metadata decoding matches the JavaScript host, and output split at any byte boundary
//! produces the same events wherever the JavaScript code had that property.

mod common;

use common::{assert_json, load, normalize, strings};
use serde_json::{Value, json};
use tc_core::Platform;
use tc_core::js::utf16_len;
use tc_core::node::Utf8Stream;
use tc_core::osc::{DirectoryReports, Report};
use tc_core::session::{LaunchToken, MetadataEvent, MetadataParser, session_metadata};

fn platform(value: &Value) -> Platform {
    Platform::from_node(value.as_str().expect("platform"))
}

fn report_events(platform: Platform, hostname: &str, chunks: &[String]) -> Vec<Value> {
    let mut decoder = DirectoryReports::new(platform, hostname);
    let mut events = Vec::new();
    for chunk in chunks {
        decoder.feed(chunk, |report| {
            events.push(match report {
                Report::Cwd(cwd) => json!({ "type": "cwd", "cwd": cwd }),
                Report::Ready(ready) => json!({ "type": "ready", "ready": ready }),
            })
        });
    }
    events
}

/// Every split of the stream's UTF-8 bytes, decoded the way the PTY reader will decode them, plus
/// one character at a time. Long streams are sampled.
fn byte_splits(stream: &str) -> impl Iterator<Item = Vec<String>> + '_ {
    let bytes = stream.as_bytes();
    let step = (bytes.len() / 1500).max(1);
    let splits = (0..=bytes.len()).step_by(step).chain([bytes.len()]).map(move |split| {
        let mut decoder = Utf8Stream::new();
        vec![
            decoder.decode(&bytes[..split]),
            decoder.decode(&bytes[split..]),
            decoder.finish(),
        ]
    });
    let chars = std::iter::once(stream.chars().map(String::from).collect());
    splits.chain(chars)
}

#[test]
fn directory_reports_match() {
    let golden = load("directory-reports.json");
    let hostname = golden["hostname"].as_str().expect("hostname");
    for case in golden["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let chunks = strings(&case["chunks"]);
        let expected = &case["events"];
        let platform = platform(&case["platform"]);
        assert_json(&Value::from(report_events(platform, hostname, &chunks)), expected, name);
        // The decoder is a character state machine, so every case splits cleanly.
        let stream = chunks.concat();
        for split in byte_splits(&stream) {
            assert_json(
                &Value::from(report_events(platform, hostname, &split)),
                expected,
                &format!("{name} (split)"),
            );
        }
    }
}

#[test]
fn directory_report_corpora_match() {
    let golden = load("directory-reports.json");
    let hostname = golden["hostname"].as_str().expect("hostname");
    let mut mismatches = Vec::new();
    for (corpus, key, prefix) in [("ninenine", "value", "9;9;"), ("osc7", "uri", "7;")] {
        let cases = golden[corpus].as_array().expect("corpus");
        assert!(!cases.is_empty());
        for case in cases {
            let payload = case[key].as_str().expect("payload");
            for (node_name, platform) in [("win32", Platform::Windows), ("linux", Platform::Linux)] {
                let events = report_events(platform, hostname, &[format!("\x1b]{prefix}{payload}\x07")]);
                let cwds = Value::from(events.iter().map(|event| event["cwd"].clone()).collect::<Vec<_>>());
                if normalize(&cwds) != normalize(&case[node_name]) {
                    mismatches.push(format!(
                        "{corpus} {node_name} {payload:?}: {cwds} != {}",
                        case[node_name]
                    ));
                }
            }
        }
    }
    assert!(
        mismatches.is_empty(),
        "{} mismatches:\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
}

struct ParserRun {
    events: Vec<Value>,
    parser: MetadataParser,
}

fn parse(options: &Value, chunks: &[String]) -> ParserRun {
    let mut parser = MetadataParser::new(
        options["cwd"].as_str().expect("cwd"),
        platform(&options["platform"]),
        options["directories"].as_bool().expect("directories"),
    );
    let mut events = Vec::new();
    for chunk in chunks {
        parser.feed(chunk, &mut |event| {
            events.push(match event {
                MetadataEvent::Change(patch) => json!({ "type": "change", "patch": patch }),
                MetadataEvent::Launch(event) => json!({ "type": "launch", "event": event }),
                MetadataEvent::End(event) => json!({ "type": "end", "event": event }),
                MetadataEvent::Warning(message) => json!({ "type": "warning", "message": message }),
            })
        });
    }
    ParserRun { events, parser }
}

#[test]
fn metadata_parser_matches() {
    let golden = load("metadata-parser.json");
    let mut split_cases = 0;
    for case in golden["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let chunks = strings(&case["chunks"]);
        let run = parse(&case["options"], &chunks);
        assert_json(&Value::from(run.events.clone()), &case["events"], name);

        let state = &case["state"];
        assert_eq!(run.parser.cwd, state["cwd"].as_str().expect("cwd"), "{name}: cwd");
        assert_eq!(
            utf16_len(run.parser.buffer()) as u64,
            state["bufferLength"].as_u64().expect("length"),
            "{name}: buffer"
        );
        assert_eq!(
            utf16_len(run.parser.text()) as u64,
            state["textLength"].as_u64().expect("length"),
            "{name}: text"
        );
        match (run.parser.launch(), &state["launch"]) {
            (None, Value::Null) => {}
            (Some(launch), expected) => {
                assert_eq!(
                    launch.provider.as_str(),
                    expected["provider"],
                    "{name}: launch provider"
                );
                let token = match &expected["token"] {
                    Value::String(token) => LaunchToken::Text(token.clone()),
                    _ => LaunchToken::Unmatchable,
                };
                assert_eq!(launch.token, token, "{name}: launch token");
            }
            (None, expected) => panic!("{name}: expected launch {expected}"),
        }

        if case["splitInvariant"] == true {
            split_cases += 1;
            for split in byte_splits(&chunks.concat()) {
                assert_json(
                    &Value::from(parse(&case["options"], &split).events),
                    &case["events"],
                    &format!("{name} (split)"),
                );
            }
        }
    }
    assert!(
        split_cases >= 15,
        "most streams split cleanly in JavaScript too ({split_cases})"
    );
}

#[test]
fn metadata_parser_file_uris_match() {
    let golden = load("metadata-parser.json");
    let mut mismatches = Vec::new();
    for case in golden["osc7"].as_array().expect("osc7") {
        let uri = case["uri"].as_str().expect("uri");
        for node_name in ["win32", "linux"] {
            let options = json!({ "cwd": "/start", "platform": node_name, "directories": true });
            let run = parse(&options, &[format!("\x1b]7;{uri}\x07")]);
            let cwds = Value::from(
                run.events
                    .iter()
                    .map(|event| event["patch"]["cwd"].clone())
                    .collect::<Vec<_>>(),
            );
            if normalize(&cwds) != normalize(&case[node_name]) {
                mismatches.push(format!("parser {node_name} {uri:?}: {cwds} != {}", case[node_name]));
            }
        }
    }
    assert!(
        mismatches.is_empty(),
        "{} mismatches:\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
}

#[test]
fn session_metadata_matches() {
    let golden = load("metadata-parser.json");
    for case in golden["sessionMetadata"].as_array().expect("sessionMetadata") {
        let actual = serde_json::to_value(session_metadata(&case["input"])).expect("serializes");
        assert_json(&actual, &case["result"], &case["input"].to_string());
    }
}
