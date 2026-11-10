//! The Node runtime behaviors the host depended on: lenient base64 and UTF-8 decoding.

mod common;

use common::load;
use tc_core::node::{Utf8Stream, base64_decode};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
        .collect()
}

#[test]
fn base64_matches_buffer_from() {
    let golden = load("node-base64.json");
    let cases = golden.as_array().expect("cases");
    assert!(cases.len() > 300);
    for case in cases {
        let input = case["input"].as_str().expect("input");
        let decoded = base64_decode(input);
        assert_eq!(hex(&decoded), case["hex"], "{input:?}");
        assert_eq!(
            String::from_utf8_lossy(&decoded),
            case["utf8"].as_str().expect("utf8"),
            "{input:?}"
        );
    }
}

#[test]
fn utf8_matches_buffer_and_string_decoder() {
    let golden = load("node-utf8.json");
    for case in golden.as_array().expect("cases") {
        let bytes = from_hex(case["hex"].as_str().expect("hex"));
        assert_eq!(
            String::from_utf8_lossy(&bytes),
            case["whole"].as_str().expect("whole"),
            "{}",
            case["hex"]
        );
        let mut stream = Utf8Stream::new();
        let mut streamed: String = bytes.iter().map(|byte| stream.decode(&[*byte])).collect();
        streamed.push_str(&stream.finish());
        assert_eq!(
            streamed,
            case["streamed"].as_str().expect("streamed"),
            "byte by byte {}",
            case["hex"]
        );
    }
}
