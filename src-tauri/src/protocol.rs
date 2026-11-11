//! The read-only `tc-asset` scheme: content-addressed images from the assets folder, by name.
//!
//! The URL is `tc-asset://images/<name>` on macOS and Linux. Windows serves custom schemes as
//! `http://tc-asset.localhost/images/<name>`. Wry reverses that workaround before calling the
//! handler, so Windows requests arrive as `tc-asset://localhost/images/<name>`.

use std::path::Path;

use tauri::http::{Response, header};
use tc_core::assets::{ImageType, asset_path};

/// The asset name a request asks for, or `None` for anything else.
pub fn asset_name(uri: &str) -> Option<String> {
    let url = tc_core::node::parse_url(uri)?;
    let encoded = match (url.protocol(), url.hostname()) {
        ("tc-asset:", "images") => url.pathname().strip_prefix('/')?,
        ("tc-asset:", "localhost") => url.pathname().strip_prefix("/images/")?,
        ("http:" | "https:", "tc-asset.localhost") => url.pathname().strip_prefix("/images/")?,
        _ => return None,
    };
    tc_core::node::decode_uri_component(encoded)
}

/// The image with `nosniff` and `no-cache`, or 404 for an unknown host, an invalid name, or a missing file.
pub fn asset_response(assets: &Path, uri: &str) -> Response<Vec<u8>> {
    let found = asset_name(uri).and_then(|name| {
        let file = asset_path(assets, &name).ok()?;
        Some((ImageType::of_asset(&name)?, std::fs::read(file).ok()?))
    });
    // Match Tauri's own asset protocol. WKWebView enforces origin checks for scheme handlers;
    // granting only the app origin lets its images load without exposing assets to remote pages.
    let origin = if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    let builder = Response::builder()
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    let response = match found {
        Some((image, body)) => builder
            .status(200)
            .header(header::CONTENT_TYPE, image.mime())
            .header(header::CACHE_CONTROL, "no-cache")
            .body(body),
        None => builder
            .status(404)
            .header(header::CONTENT_TYPE, "text/plain")
            .body(b"Not found".to_vec()),
    };
    response.expect("static response parts are valid")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_and_remapped_urls_name_the_same_asset() {
        let name = format!("{}.png", "a".repeat(64));
        assert_eq!(asset_name(&format!("tc-asset://images/{name}")), Some(name.clone()));
        assert_eq!(
            asset_name(&format!("tc-asset://localhost/images/{name}")),
            Some(name.clone())
        );
        assert_eq!(asset_name(&format!("tc-asset://localhost/{name}")), None);
        assert_eq!(
            asset_name(&format!("http://tc-asset.localhost/images/{name}")),
            Some(name.clone())
        );
        assert_eq!(asset_name(&format!("tc-asset://other/{name}")), None);
        assert_eq!(asset_name(&format!("http://tc-asset.localhost/{name}")), None);
        assert_eq!(asset_name(&format!("http://example.com/images/{name}")), None);
        assert_eq!(asset_name("tc-asset://images/a%20b"), Some("a b".into()));
    }

    #[test]
    fn serves_only_stored_content_addressed_images() {
        let dir = std::env::temp_dir().join(format!("tc-protocol-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let png = b"\x89PNG\r\n\x1a\n-image";
        let name = tc_core::assets::store_image(&dir, png).unwrap();
        let response = asset_response(&dir, &format!("tc-asset://images/{name}"));
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(response.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-cache");
        assert_eq!(
            response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            if cfg!(windows) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
        );
        assert_eq!(response.body(), png);
        let windows = asset_response(&dir, &format!("tc-asset://localhost/images/{name}"));
        assert_eq!(windows.status(), 200);
        assert_eq!(windows.body(), png);
        for bad in [
            "tc-asset://images/..%2Fworkspace.terminalcanvas".to_owned(),
            format!("tc-asset://images/{}.png", "b".repeat(64)),
            format!("tc-asset://elsewhere/{name}"),
            "tc-asset://images/%E0%A4%A".to_owned(),
        ] {
            let response = asset_response(&dir, &bad);
            assert_eq!(response.status(), 404, "{bad}");
            assert_eq!(response.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
