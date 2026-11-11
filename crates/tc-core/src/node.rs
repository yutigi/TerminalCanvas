//! Node.js runtime behaviors the JavaScript host depended on without spelling them out.
//!
//! Each function reproduces what Node 22 does, including its leniency, so inputs the old host accepted
//! keep working. `tests/golden/node-*.json` and the OSC 7 corpus pin these down.
//!
//! URLs are parsed with Ada, the WHATWG parser inside Node. rust-url differs from it on `file:` URLs
//! that matter here: it drops the host before a drive letter (`file://host/C:/`), keeps the legacy
//! `c|` drive form, and collapses a leading empty path segment.

pub use ada_url::Url;

/// `Buffer.from(text, 'base64')`. Node ignores characters outside the alphabet, accepts the URL-safe
/// alphabet too, stops at the first `=`, and reads each UTF-16 unit by its low byte.
pub fn base64_decode(text: &str) -> Vec<u8> {
    let mut output = Vec::with_capacity(text.len() * 3 / 4);
    let mut accumulator: u32 = 0;
    let mut bits = 0;
    for unit in text.encode_utf16() {
        let byte = (unit & 0xff) as u8;
        let value = match byte {
            b'=' => break,
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => continue,
        };
        accumulator = (accumulator << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((accumulator >> bits) as u8);
            accumulator &= (1 << bits) - 1;
        }
    }
    output
}

/// `decodeURIComponent`: every escape is decoded. A malformed escape or invalid UTF-8 gives `None`.
pub fn decode_uri_component(text: &str) -> Option<String> {
    if !text.contains('%') {
        return Some(text.to_owned());
    }
    let mut output = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            let next = text[index..].find('%').map_or(bytes.len(), |offset| index + offset);
            output.push_str(&text[index..next]);
            index = next;
            continue;
        }
        let mut decoded = Vec::new();
        while index < bytes.len() && bytes[index] == b'%' {
            let hex = text
                .get(index + 1..index + 3)
                .filter(|hex| hex.bytes().all(|b| b.is_ascii_hexdigit()))?;
            decoded.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        }
        output.push_str(std::str::from_utf8(&decoded).ok()?);
    }
    Some(output)
}

/// `new URL(input)`, or `None` where it throws.
pub fn parse_url(input: &str) -> Option<Url> {
    Url::parse(input, None).ok()
}

/// `url.domainToUnicode` for a host the URL parser already accepted.
pub fn domain_to_unicode(host: &str) -> String {
    ada_url::Idna::unicode(host)
}

/// `fileURLToPath(url, { windows })` for a `file:` URL's hostname and percent-encoded pathname, or
/// `None` where Node throws.
pub fn file_url_to_path(hostname: &str, pathname: &str, windows: bool) -> Option<String> {
    if windows {
        if has_encoded_separator(pathname, true) {
            return None;
        }
        let path = decode_uri_component(&pathname.replace('/', "\\"))?;
        if !hostname.is_empty() {
            // A host makes this a UNC path.
            return Some(format!("\\\\{}{}", domain_to_unicode(hostname), path));
        }
        // Otherwise it must start with a drive letter: `\C:...`.
        let mut chars = path.chars();
        chars.next();
        let letter = chars.next().map_or(0x20, |c| c as u32 | 0x20);
        if !(u32::from(b'a')..=u32::from(b'z')).contains(&letter) || chars.next() != Some(':') {
            return None;
        }
        Some(path[1..].to_owned())
    } else {
        if !hostname.is_empty() || has_encoded_separator(pathname, false) {
            return None;
        }
        decode_uri_component(pathname)
    }
}

/// `%2F` always, and `%5C` too on Windows, in either case.
fn has_encoded_separator(pathname: &str, backslash: bool) -> bool {
    pathname.as_bytes().windows(3).any(|w| {
        w[0] == b'%' && ((w[1] == b'2' && w[2] | 0x20 == b'f') || (backslash && w[1] == b'5' && w[2] | 0x20 == b'c'))
    })
}

/// A streaming UTF-8 decoder that behaves like Node's `StringDecoder`: a sequence split across two
/// reads is joined, and each maximal invalid subsequence becomes U+FFFD.
#[derive(Debug, Default, Clone)]
pub struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub fn new() -> Self {
        Self::default()
    }

    /// Decodes `input`, holding back an incomplete sequence at the end for the next call.
    pub fn decode(&mut self, input: &[u8]) -> String {
        let mut joined;
        let mut rest = if self.pending.is_empty() {
            input
        } else {
            joined = std::mem::take(&mut self.pending);
            joined.extend_from_slice(input);
            &joined[..]
        };
        let mut output = String::with_capacity(rest.len());
        loop {
            match std::str::from_utf8(rest) {
                Ok(text) => {
                    output.push_str(text);
                    return output;
                }
                Err(error) => {
                    let (valid, after) = rest.split_at(error.valid_up_to());
                    output.push_str(std::str::from_utf8(valid).expect("validated prefix"));
                    match error.error_len() {
                        Some(length) => {
                            output.push(char::REPLACEMENT_CHARACTER);
                            rest = &after[length..];
                        }
                        None => {
                            self.pending = after.to_vec();
                            return output;
                        }
                    }
                }
            }
        }
    }

    /// Flushes an incomplete final sequence as U+FFFD.
    pub fn finish(&mut self) -> String {
        if self.pending.is_empty() {
            String::new()
        } else {
            String::from_utf8_lossy(&std::mem::take(&mut self.pending)).into_owned()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_uri_component_rejects_malformed_escapes() {
        assert_eq!(decode_uri_component("a%20b%25%E5%AD%90"), Some("a b%子".to_owned()));
        assert_eq!(decode_uri_component("%2f%5C"), Some("/\\".to_owned()));
        for bad in ["%", "%z1", "%1", "%FF", "%E5%AD", "%ED%A0%80", "%C0%AF", "%+1"] {
            assert_eq!(decode_uri_component(bad), None, "{bad}");
        }
    }

    #[test]
    fn file_urls_follow_the_requested_platform() {
        assert_eq!(file_url_to_path("", "/C:/a%20b", true), Some("C:\\a b".to_owned()));
        assert_eq!(
            file_url_to_path("server", "/share", true),
            Some("\\\\server\\share".to_owned())
        );
        assert_eq!(file_url_to_path("", "/C", true), None);
        assert_eq!(file_url_to_path("", "/a%5Cb", true), None);
        assert_eq!(file_url_to_path("", "/a%5Cb", false), Some("/a\\b".to_owned()));
        assert_eq!(file_url_to_path("", "/a%2fb", false), None);
        assert_eq!(file_url_to_path("host", "/a", false), None);
    }

    #[test]
    fn utf8_stream_joins_split_sequences() {
        let mut stream = Utf8Stream::new();
        assert_eq!(stream.decode(&[0xe5, 0xad]), "");
        assert_eq!(stream.decode(&[0x90, 0xff, b'a']), "子\u{fffd}a");
        assert_eq!(stream.decode(&[0xf0, 0x9f]), "");
        assert_eq!(stream.finish(), "\u{fffd}");
    }
}
