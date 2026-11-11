//! JavaScript string and number semantics that the ported checks depend on.
//!
//! The JavaScript host measured strings in UTF-16 code units and trimmed with `String.prototype.trim`.
//! Rust's `len()` counts bytes and `trim()` uses a different whitespace set, so the ports use these.

use serde::Serializer;
use serde_json::Value;

/// The length JavaScript reports for `value.length`.
pub fn utf16_len(value: &str) -> usize {
    value.chars().map(char::len_utf16).sum()
}

/// The characters `String.prototype.trim` removes: WhiteSpace and LineTerminator in ECMAScript.
/// Unlike `char::is_whitespace`, this includes U+FEFF and excludes U+0085.
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// `String.prototype.trim`.
pub fn trim(value: &str) -> &str {
    value.trim_matches(is_js_whitespace)
}

/// `value.slice(-units)`, measured in UTF-16 units. A surrogate pair that the cut would split is
/// dropped whole, because a Rust string cannot hold half of one.
pub fn last_utf16(value: &str, units: usize) -> &str {
    let mut kept = 0;
    let mut start = value.len();
    for (index, c) in value.char_indices().rev() {
        kept += c.len_utf16();
        if kept > units {
            break;
        }
        start = index;
    }
    &value[start..]
}

/// Whether `value` contains a C0 control character, the `/[\x00-\x1f]/` test.
pub fn has_c0_control(value: &str) -> bool {
    value.bytes().any(|b| b < 0x20)
}

/// JavaScript truthiness for a JSON value.
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// Writes a number the way `JSON.stringify` does for the values the host stores: whole numbers
/// without a fraction (`48`, not `48.0`) and `-0` as `0`.
pub fn serialize_number<S: Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    const SAFE_INTEGER: f64 = 9_007_199_254_740_992.0;
    if value.fract() == 0.0 && value.abs() < SAFE_INTEGER {
        serializer.serialize_i64(*value as i64)
    } else {
        serializer.serialize_f64(*value)
    }
}

/// The order `Object.entries` uses: integer-like keys ascending, then the rest in insertion order.
pub fn object_entries(map: &serde_json::Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut indexed: Vec<(u32, (&String, &Value))> = Vec::new();
    let mut named = Vec::new();
    for entry in map {
        match array_index(entry.0) {
            Some(index) => indexed.push((index, entry)),
            None => named.push(entry),
        }
    }
    indexed.sort_by_key(|(index, _)| *index);
    indexed.into_iter().map(|(_, entry)| entry).chain(named).collect()
}

/// A canonical array index: "0", or digits without a leading zero, up to 2^32 - 2.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || !key.bytes().all(|b| b.is_ascii_digit()) || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    key.parse::<u32>().ok().filter(|&index| index != u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_lengths_count_surrogate_pairs_twice() {
        assert_eq!(utf16_len("é子"), 2);
        assert_eq!(utf16_len("🚀"), 2);
        assert_eq!(utf16_len(""), 0);
    }

    #[test]
    fn trim_matches_ecmascript() {
        assert_eq!(trim("\u{feff} a \u{3000}"), "a");
        assert_eq!(trim("\u{85}a\u{85}"), "\u{85}a\u{85}");
        assert_eq!(trim("\u{180e}a"), "\u{180e}a");
        assert_eq!(trim("\u{2028}\u{a0}a\t\n"), "a");
    }

    #[test]
    fn last_utf16_drops_split_pairs() {
        assert_eq!(last_utf16("abc", 2), "bc");
        assert_eq!(last_utf16("a🚀", 2), "🚀");
        assert_eq!(last_utf16("a🚀", 1), "");
        assert_eq!(last_utf16("abc", 10), "abc");
    }

    #[test]
    fn numbers_serialize_like_json_stringify() {
        #[derive(serde::Serialize)]
        struct N(#[serde(serialize_with = "serialize_number")] f64);
        let text = |n| serde_json::to_string(&N(n)).unwrap();
        assert_eq!(text(48.0), "48");
        assert_eq!(text(-0.0), "0");
        assert_eq!(text(-12.5), "-12.5");
        assert_eq!(text(0.35), "0.35");
    }

    #[test]
    fn object_entries_put_array_indices_first() {
        let map: serde_json::Map<String, Value> =
            serde_json::from_str(r#"{"b":1,"7":2,"a":3,"01":4,"0":5,"4294967295":6,"4294967294":7}"#).unwrap();
        let keys: Vec<&str> = object_entries(&map).into_iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["0", "7", "4294967294", "b", "a", "01", "4294967295"]);
    }

    #[test]
    fn truthiness() {
        assert!(!truthy(None));
        assert!(!truthy(Some(&Value::from(""))));
        assert!(!truthy(Some(&Value::from(0))));
        assert!(truthy(Some(&Value::from("x"))));
        assert!(truthy(Some(&serde_json::json!([]))));
    }
}
