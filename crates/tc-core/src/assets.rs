//! Image assets, from `src/assets.cjs`.
//!
//! Images live content-addressed in the app's data folder and workspaces reference them by name.
//! These functions run synchronously; the host runs every task that writes or deletes stored
//! images on one serial queue, as the JavaScript host did, so a cleanup can never delete a file an
//! import just handed out.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::js::object_entries;
use crate::workspace::{ItemKind, Workspace, is_asset_name};
use crate::{Result, atomic, invalid, node};

/// The largest image the host stores.
pub const IMAGE_BYTES: usize = 15 * 1024 * 1024;
/// The most image names a cleanup request may list.
pub const KEEP_LIMIT: usize = 200_000;

string_enum! {
    /// A supported image format, named by its stored file extension.
    pub enum ImageType {
        Png = "png",
        Jpg = "jpg",
        Gif = "gif",
        Webp = "webp",
    }
}

impl ImageType {
    pub fn mime(self) -> &'static str {
        match self {
            ImageType::Png => "image/png",
            ImageType::Jpg => "image/jpeg",
            ImageType::Gif => "image/gif",
            ImageType::Webp => "image/webp",
        }
    }

    /// The type of a stored asset, from its validated name.
    pub fn of_asset(name: &str) -> Option<Self> {
        name.rsplit_once('.').and_then(|(_, extension)| Self::parse(extension))
    }
}

/// File contents decide the type; names and declared MIME types are never trusted. SVG is excluded.
pub fn detect_image(bytes: &[u8]) -> Result<ImageType> {
    if bytes.is_empty() || bytes.len() > IMAGE_BYTES {
        return invalid("Images must be between 1 byte and 15 MB.");
    }
    let image = if bytes.len() > 8 && bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        ImageType::Png
    } else if bytes.len() > 3 && bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        ImageType::Jpg
    } else if bytes.len() > 6 && (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) {
        ImageType::Gif
    } else if bytes.len() > 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        ImageType::Webp
    } else {
        return invalid("Only PNG, JPEG, GIF, and WebP images are supported.");
    };
    Ok(image)
}

/// The stored file for an asset name. Anything but a content-addressed image name is rejected.
pub fn asset_path(directory: &Path, name: &str) -> Result<PathBuf> {
    if !is_asset_name(name) {
        return invalid("Invalid image asset.");
    }
    Ok(directory.join(name))
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Stores an image under the hash of its bytes and returns its name. An existing file is reused.
pub fn store_image(directory: &Path, bytes: &[u8]) -> Result<String> {
    let image = detect_image(bytes)?;
    let name = format!("{}.{}", sha256_hex(bytes), image.as_str());
    let file = asset_path(directory, &name)?;
    if fs::metadata(&file).is_ok() {
        return Ok(name);
    }
    fs::create_dir_all(directory)?;
    atomic::write(&file, bytes, atomic::Access::Default)?;
    Ok(name)
}

/// The images a workspace uses, each once, in order.
pub fn image_names(board: &Workspace) -> Vec<&str> {
    let mut seen = HashSet::new();
    board
        .items
        .iter()
        .filter_map(|item| match &item.kind {
            ItemKind::Image { asset, .. } => Some(asset.as_str()),
            _ => None,
        })
        .filter(|name| seen.insert(*name))
        .collect()
}

/// The images of a portable export.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Embedded {
    /// Name to `data:` URL, in workspace order.
    pub assets: Map<String, Value>,
    /// Referenced images that could not be read. They are reported, not skipped silently.
    pub missing: Vec<String>,
}

/// Portable exports carry every referenced image as a data URL.
pub fn embed_assets(board: &Workspace, directory: &Path) -> Embedded {
    let mut embedded = Embedded {
        assets: Map::new(),
        missing: Vec::new(),
    };
    for name in image_names(board) {
        let read = asset_path(directory, name).and_then(|file| Ok(fs::read(file)?));
        match read.and_then(|bytes| Ok((detect_image(&bytes)?, bytes))) {
            Ok((image, bytes)) => {
                let url = format!(
                    "data:{};base64,{}",
                    image.mime(),
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                );
                embedded.assets.insert(name.to_owned(), Value::String(url));
            }
            Err(_) => embedded.missing.push(name.to_owned()),
        }
    }
    embedded
}

/// The base64 payload of `data:image/<letters>;base64,<payload>`.
fn image_data_url(url: &str) -> Option<&str> {
    let rest = url.strip_prefix("data:image/")?;
    let (subtype, payload) = rest.split_once(";base64,")?;
    let valid_subtype = !subtype.is_empty() && subtype.bytes().all(|b| b.is_ascii_lowercase());
    let valid_payload = !payload.is_empty()
        && payload
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b));
    (valid_subtype && valid_payload).then_some(payload)
}

/// Stores the images embedded in an opened file and removes them from it. Every image is hashed
/// again, so a file cannot plant content under a mismatched name; items are renamed to match.
/// Input without an `assets` field is returned unchanged.
pub fn extract_assets(raw: Value, directory: &Path) -> Result<Value> {
    let Value::Object(mut board) = raw else { return Ok(raw) };
    let Some(embedded) = board.get("assets") else {
        return Ok(Value::Object(board));
    };
    let Value::Object(embedded) = embedded else {
        return invalid("Invalid embedded images.");
    };
    let mut renamed = HashMap::new();
    for (name, url) in object_entries(embedded) {
        let payload = url.as_str().and_then(image_data_url);
        let (true, Some(payload)) = (is_asset_name(name), payload) else {
            return invalid("Invalid embedded image.");
        };
        renamed.insert(name.clone(), store_image(directory, &node::base64_decode(payload))?);
    }
    board.shift_remove("assets");
    if let Some(Value::Array(items)) = board.get_mut("items") {
        for item in items {
            let Some(fields) = item.as_object_mut() else { continue };
            if fields.get("type").and_then(Value::as_str) != Some("image") {
                continue;
            }
            if let Some(stored) = fields
                .get("asset")
                .and_then(Value::as_str)
                .and_then(|name| renamed.get(name))
            {
                fields.insert("asset".to_owned(), Value::String(stored.clone()));
            }
        }
    }
    Ok(Value::Object(board))
}

/// The images the renderer still uses: the workspace, its undo history, and copied items.
pub fn keep_list(raw: &Value) -> Result<HashSet<String>> {
    let names = raw
        .as_array()
        .filter(|names| names.len() <= KEEP_LIMIT)
        .and_then(|names| {
            names
                .iter()
                .map(|name| name.as_str().filter(|name| is_asset_name(name)).map(str::to_owned))
                .collect()
        });
    match names {
        Some(names) => Ok(names),
        None => invalid("Invalid image list."),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StoredAsset {
    pub name: String,
    pub bytes: u64,
}

/// Stored images not in `keep`, by name. Only content-addressed image files are ever considered.
pub fn unused_assets(directory: &Path, keep: &HashSet<String>) -> io::Result<Vec<StoredAsset>> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut names = Vec::new();
    for entry in entries {
        if let Ok(name) = entry?.file_name().into_string() {
            names.push(name);
        }
    }
    names.sort();
    Ok(names
        .into_iter()
        .filter(|name| is_asset_name(name) && !keep.contains(name))
        .filter_map(|name| {
            let metadata = fs::metadata(directory.join(&name)).ok().filter(fs::Metadata::is_file)?;
            Some(StoredAsset {
                name,
                bytes: metadata.len(),
            })
        })
        .collect())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct Deleted {
    pub deleted: u64,
    pub bytes: u64,
    pub failed: u64,
}

/// Deletes stored images. A file another program holds open (common on Windows) is counted as
/// failed rather than stopping the cleanup; a file that is already gone is skipped.
pub fn delete_assets(directory: &Path, assets: &[StoredAsset]) -> Deleted {
    let mut result = Deleted::default();
    for asset in assets {
        match asset_path(directory, &asset.name).map(fs::remove_file) {
            Ok(Ok(())) => {
                result.deleted += 1;
                result.bytes += asset.bytes;
            }
            Ok(Err(error)) if error.kind() == io::ErrorKind::NotFound => {}
            _ => result.failed += 1,
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_urls_need_a_lowercase_image_type_and_base64() {
        assert_eq!(image_data_url("data:image/png;base64,AAAA"), Some("AAAA"));
        assert_eq!(image_data_url("data:image/PNG;base64,AAAA"), None);
        assert_eq!(image_data_url("data:image/svg+xml;base64,AAAA"), None);
        assert_eq!(image_data_url("data:image/png;base64,"), None);
        assert_eq!(image_data_url("data:image/png;base64,AA-_"), None);
        assert_eq!(image_data_url("data:text/html;base64,AAAA"), None);
    }

    #[test]
    fn embedded_images_are_read_in_object_entry_order() {
        // JavaScript visits the integer-like key first, whatever order the file lists it in.
        let raw: Value = serde_json::from_str(&format!(
            r#"{{"assets":{{"{}.png":"data:image/png;base64,PHN2Zy8+","7":"data:image/png;base64,AAAA"}}}}"#,
            "a".repeat(64)
        ))
        .unwrap();
        let error = extract_assets(raw, &std::env::temp_dir().join("tc-never-created")).unwrap_err();
        assert_eq!(error.to_string(), "Invalid embedded image.");
    }
}
