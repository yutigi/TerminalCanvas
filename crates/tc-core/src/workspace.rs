//! Workspace validation and the card profiles, from `src/workspace.cjs`.
//!
//! Validation works on `serde_json::Value` with hand-written checks in the same order as the
//! JavaScript code, so error messages and format migrations stay identical. A derived
//! `Deserialize` would change both. The typed result serializes to the same JSON the JavaScript
//! host wrote: the same field order, defaults left out, and whole numbers without `.0`.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use serde::ser::{SerializeMap, Serializer};
use serde_json::{Map, Value, json};

use crate::js::{has_c0_control, serialize_number, trim, truthy, utf16_len};
use crate::session::{SessionMetadata, session_metadata};
use crate::styles::{COLORED_TYPES, Color, FontSize, GROUP_DEPTH, TEXT_TYPES};
use crate::{Result, invalid};

/// The current workspace format. Formats 1 and 2 are migrated on load.
pub const VERSION: u32 = 3;

pub mod limits {
    pub const ITEMS: usize = 1000;
    /// The largest workspace file the host reads.
    pub const BYTES: u64 = 64 * 1024 * 1024;
    pub const COORDINATE: f64 = 100_000.0;
    /// Board text, in UTF-16 units.
    pub const TEXT: usize = 10_000;
    pub const GROUP_DEPTH: usize = super::GROUP_DEPTH;
}

pub const ITEM_TYPES: [&str; 6] = ["text", "note", "shape", "frame", "image", "line"];
pub const ITEM_SIZE_MIN: f64 = 8.0;
pub const ITEM_SIZE_MAX: f64 = 8000.0;

string_enum! {
    pub enum ProfileId {
        Shell = "shell",
        Claude = "claude",
        Codex = "codex",
        Gemini = "gemini",
        Custom = "custom",
    }
}

string_enum! {
    pub enum Shape {
        Rect = "rect",
        Ellipse = "ellipse",
    }
}

/// A kind of terminal card the UI offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Profile {
    pub id: ProfileId,
    pub name: &'static str,
    pub command: &'static str,
    pub color: &'static str,
    pub initials: &'static str,
}

pub const PROFILES: [Profile; 5] = [
    Profile {
        id: ProfileId::Shell,
        name: "Terminal",
        command: "",
        color: "#94a3b8",
        initials: ">_",
    },
    Profile {
        id: ProfileId::Claude,
        name: "Claude Code",
        command: "claude",
        color: "#d6a181",
        initials: "CC",
    },
    Profile {
        id: ProfileId::Codex,
        name: "Codex",
        command: "codex",
        color: "#8dd9bd",
        initials: "CX",
    },
    Profile {
        id: ProfileId::Gemini,
        name: "Gemini CLI",
        command: "gemini",
        color: "#93b4ff",
        initials: "GM",
    },
    Profile {
        id: ProfileId::Custom,
        name: "Custom command",
        command: "",
        color: "#c4a3ff",
        initials: "AI",
    },
];

impl ProfileId {
    pub fn profile(self) -> &'static Profile {
        PROFILES
            .iter()
            .find(|profile| profile.id == self)
            .expect("every profile ID has a profile")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Camera {
    #[serde(serialize_with = "serialize_number")]
    pub x: f64,
    #[serde(serialize_with = "serialize_number")]
    pub y: f64,
    #[serde(serialize_with = "serialize_number")]
    pub z: f64,
}

/// A terminal card. Runtime state such as the process ID or output is never part of it.
#[derive(Debug, Clone, PartialEq)]
pub struct Card {
    pub id: String,
    pub profile: ProfileId,
    pub title: String,
    pub cwd: String,
    pub command: String,
    pub session: Option<SessionMetadata>,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// Outermost first. Empty when ungrouped.
    pub groups: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// One end of a line: attached to another element, or a free point.
#[derive(Debug, Clone, PartialEq)]
pub enum Endpoint {
    Element(String),
    Point { x: f64, y: f64 },
}

#[derive(Debug, Clone, PartialEq)]
pub enum ItemKind {
    Text {
        rect: Rect,
        text: String,
    },
    Note {
        rect: Rect,
        text: String,
    },
    Shape {
        rect: Rect,
        shape: Shape,
        text: String,
    },
    Frame {
        rect: Rect,
        title: String,
    },
    /// `asset` is a content-addressed file name in the assets folder.
    Image {
        rect: Rect,
        asset: String,
    },
    Line {
        start: Endpoint,
        end: Endpoint,
        arrow: bool,
    },
}

impl ItemKind {
    pub fn type_name(&self) -> &'static str {
        match self {
            ItemKind::Text { .. } => "text",
            ItemKind::Note { .. } => "note",
            ItemKind::Shape { .. } => "shape",
            ItemKind::Frame { .. } => "frame",
            ItemKind::Image { .. } => "image",
            ItemKind::Line { .. } => "line",
        }
    }
}

/// A board item: text, a sticky note, a shape, a frame, an image, or a line.
#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub id: String,
    pub kind: ItemKind,
    pub color: Option<Color>,
    pub font_size: Option<FontSize>,
    pub groups: Vec<String>,
}

/// A validated workspace in the current format.
#[derive(Debug, Clone, PartialEq)]
pub struct Workspace {
    pub name: String,
    pub camera: Camera,
    pub cards: Vec<Card>,
    pub items: Vec<Item>,
}

impl Workspace {
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("workspaces serialize")
    }

    /// The text of a workspace file. `assets` holds the embedded images of a portable export.
    pub fn to_file_string(&self, assets: Option<&Map<String, Value>>) -> String {
        let mut value = self.to_value();
        if let (Some(assets), Value::Object(fields)) = (assets, &mut value) {
            fields.insert("assets".to_owned(), Value::Object(assets.clone()));
        }
        serde_json::to_string_pretty(&value).expect("workspaces serialize")
    }
}

/// Serializes a number like `JSON.stringify`.
struct Number(f64);

impl Serialize for Number {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serialize_number(&self.0, serializer)
    }
}

impl Serialize for Workspace {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(5))?;
        map.serialize_entry("version", &VERSION)?;
        map.serialize_entry("name", &self.name)?;
        map.serialize_entry("camera", &self.camera)?;
        map.serialize_entry("cards", &self.cards)?;
        map.serialize_entry("items", &self.items)?;
        map.end()
    }
}

impl Serialize for Card {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("id", &self.id)?;
        map.serialize_entry("type", "terminal")?;
        map.serialize_entry("profile", &self.profile)?;
        map.serialize_entry("title", &self.title)?;
        map.serialize_entry("cwd", &self.cwd)?;
        map.serialize_entry("command", &self.command)?;
        if let Some(session) = &self.session {
            map.serialize_entry("session", session)?;
        }
        map.serialize_entry("x", &Number(self.x))?;
        map.serialize_entry("y", &Number(self.y))?;
        map.serialize_entry("w", &Number(self.w))?;
        map.serialize_entry("h", &Number(self.h))?;
        if !self.groups.is_empty() {
            map.serialize_entry("groups", &self.groups)?;
        }
        map.end()
    }
}

impl Serialize for Endpoint {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        match self {
            Endpoint::Element(id) => map.serialize_entry("id", id)?,
            Endpoint::Point { x, y } => {
                map.serialize_entry("x", &Number(*x))?;
                map.serialize_entry("y", &Number(*y))?;
            }
        }
        map.end()
    }
}

impl Serialize for Item {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("id", &self.id)?;
        map.serialize_entry("type", self.kind.type_name())?;
        let rect = |map: &mut S::SerializeMap, rect: &Rect| -> Result<(), S::Error> {
            map.serialize_entry("x", &Number(rect.x))?;
            map.serialize_entry("y", &Number(rect.y))?;
            map.serialize_entry("w", &Number(rect.w))?;
            map.serialize_entry("h", &Number(rect.h))
        };
        match &self.kind {
            ItemKind::Line { start, end, arrow } => {
                map.serialize_entry("start", start)?;
                map.serialize_entry("end", end)?;
                map.serialize_entry("arrow", arrow)?;
            }
            ItemKind::Text { rect: r, text } | ItemKind::Note { rect: r, text } => {
                rect(&mut map, r)?;
                map.serialize_entry("text", text)?;
            }
            ItemKind::Shape { rect: r, shape, text } => {
                rect(&mut map, r)?;
                map.serialize_entry("shape", shape)?;
                map.serialize_entry("text", text)?;
            }
            ItemKind::Frame { rect: r, title } => {
                rect(&mut map, r)?;
                map.serialize_entry("title", title)?;
            }
            ItemKind::Image { rect: r, asset } => {
                rect(&mut map, r)?;
                map.serialize_entry("asset", asset)?;
            }
        }
        if let Some(color) = self.color {
            map.serialize_entry("color", &color)?;
        }
        if let Some(size) = self.font_size {
            map.serialize_entry("fontSize", &size)?;
        }
        if !self.groups.is_empty() {
            map.serialize_entry("groups", &self.groups)?;
        }
        map.end()
    }
}

/* ---------- Field checks ---------- */

/// `raw.key`: absent for non-objects, like a property read on a JavaScript primitive.
fn field<'a>(raw: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    raw?.as_object()?.get(key)
}

/// A number within `min..=max`. JSON cannot carry `Infinity` or `NaN`.
fn finite(value: Option<&Value>, min: f64, max: f64) -> Option<f64> {
    value?.as_f64().filter(|n| (min..=max).contains(n))
}

/// A single-line string of at most `max` UTF-16 units, trimmed.
fn text(value: Option<&Value>, max: usize, label: &str) -> Result<String> {
    match value {
        Some(Value::String(s)) if utf16_len(s) <= max && !has_c0_control(s) => Ok(trim(s).to_owned()),
        _ => invalid(format!("Invalid {label}.")),
    }
}

/// Board text: newlines and tabs are allowed, CR and CRLF become LF, and nothing is trimmed.
fn multiline(value: Option<&Value>, label: &str) -> Result<String> {
    let Some(value) = value else { return Ok(String::new()) };
    let Value::String(raw) = value else {
        return invalid(format!("Invalid {label}."));
    };
    let mut normalized = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' {
            chars.next_if_eq(&'\n');
            normalized.push('\n');
        } else {
            normalized.push(c);
        }
    }
    let control = normalized.bytes().any(|b| b < 0x20 && b != b'\t' && b != b'\n');
    if utf16_len(&normalized) > limits::TEXT || control {
        return invalid(format!("Invalid {label}."));
    }
    Ok(normalized)
}

fn identifier(value: Option<&Value>, label: &str) -> Result<String> {
    let id = text(value, 80, label)?;
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return invalid(format!("Invalid {label}."));
    }
    Ok(id)
}

fn position(raw: Option<&Value>, label: &str) -> Result<(f64, f64)> {
    let axis = |key| {
        finite(field(raw, key), -limits::COORDINATE, limits::COORDINATE)
            .ok_or_else(|| crate::Error::Invalid(format!("Invalid {label} position.")))
    };
    Ok((axis("x")?, axis("y")?))
}

/// `groups` lists an element's groups from the outermost to the innermost. Format 2 stored one `group`.
fn groups(raw: &Value, version: u32) -> Result<Vec<String>> {
    let migrated;
    let groups = if version < 3 {
        match field(Some(raw), "group") {
            None | Some(Value::Null) => return Ok(Vec::new()),
            Some(group) => {
                migrated = Value::Array(vec![group.clone()]);
                &migrated
            }
        }
    } else {
        match field(Some(raw), "groups") {
            None | Some(Value::Null) => return Ok(Vec::new()),
            Some(groups) => groups,
        }
    };
    let Some(list) = groups.as_array().filter(|list| list.len() <= limits::GROUP_DEPTH) else {
        return invalid("Invalid groups.");
    };
    let ids = list
        .iter()
        .map(|group| identifier(Some(group), "group ID"))
        .collect::<Result<Vec<_>>>()?;
    if ids.iter().collect::<HashSet<_>>().len() != ids.len() {
        return invalid("Invalid groups.");
    }
    Ok(ids)
}

fn style(raw: &Value, item_type: &str) -> Result<(Option<Color>, Option<FontSize>)> {
    let set = |key, default| match field(Some(raw), key) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s == default => None,
        Some(value) => Some(value.as_str()),
    };
    let mut color = None;
    if COLORED_TYPES.contains(&item_type)
        && let Some(value) = set("color", "default")
    {
        color = Some(
            value
                .and_then(Color::parse)
                .ok_or_else(|| crate::Error::Invalid("Unsupported item color.".into()))?,
        );
    }
    let mut font_size = None;
    if TEXT_TYPES.contains(&item_type)
        && let Some(value) = set("fontSize", "medium")
    {
        font_size = Some(
            value
                .and_then(FontSize::parse)
                .ok_or_else(|| crate::Error::Invalid("Unsupported text size.".into()))?,
        );
    }
    Ok((color, font_size))
}

/* ---------- Validation ---------- */

/// Validates a terminal card from a workspace in `version`'s format.
pub fn validate_card(card: &Value, version: u32) -> Result<Card> {
    if field(Some(card), "type").and_then(Value::as_str) != Some("terminal") {
        return invalid("Unsupported card type.");
    }
    let raw = Some(card);
    let id = identifier(field(raw, "id"), "card ID")?;
    let Some(profile) = field(raw, "profile").and_then(Value::as_str).and_then(ProfileId::parse) else {
        return invalid("Unknown terminal profile.");
    };
    let mut title = text(field(raw, "title"), 100, "title")?;
    if title.is_empty() {
        "Terminal".clone_into(&mut title);
    }
    let cwd = text(field(raw, "cwd"), 4096, "working directory")?;
    let command = text(field(raw, "command"), 2000, "command")?;
    // Optional recovery metadata is best effort: a bad ID never discards the layout.
    let session = field(raw, "session").and_then(session_metadata);
    let (x, y) = position(raw, "card")?;
    let size = |key, min, max| {
        finite(field(raw, key), min, max).ok_or_else(|| crate::Error::Invalid("Invalid card size.".into()))
    };
    let w = size("w", 400.0, 2400.0)?;
    let h = size("h", 280.0, 1800.0)?;
    let groups = groups(card, version)?;
    Ok(Card {
        id,
        profile,
        title,
        cwd,
        command,
        session,
        x,
        y,
        w,
        h,
        groups,
    })
}

fn endpoint(raw: Option<&Value>) -> Result<Endpoint> {
    if let Some(Value::Object(fields)) = raw
        && fields.contains_key("id")
    {
        return Ok(Endpoint::Element(identifier(fields.get("id"), "connector target")?));
    }
    let (x, y) = position(raw, "line endpoint")?;
    Ok(Endpoint::Point { x, y })
}

/// Validates a board item from a workspace in `version`'s format.
pub fn validate_item(raw: &Value, version: u32) -> Result<Item> {
    let Some(item_type) = field(Some(raw), "type")
        .and_then(Value::as_str)
        .filter(|t| ITEM_TYPES.contains(t))
    else {
        return invalid("Unsupported canvas item type.");
    };
    let fields = Some(raw);
    let id = identifier(field(fields, "id"), "item ID")?;
    let kind = if item_type == "line" {
        let start = endpoint(field(fields, "start"))?;
        let end = endpoint(field(fields, "end"))?;
        ItemKind::Line {
            start,
            end,
            arrow: field(fields, "arrow") == Some(&Value::Bool(true)),
        }
    } else {
        let (x, y) = position(fields, "item")?;
        let size = |key| {
            finite(field(fields, key), ITEM_SIZE_MIN, ITEM_SIZE_MAX)
                .ok_or_else(|| crate::Error::Invalid("Invalid item size.".into()))
        };
        let rect = Rect {
            x,
            y,
            w: size("w")?,
            h: size("h")?,
        };
        match item_type {
            "text" => ItemKind::Text {
                rect,
                text: multiline(field(fields, "text"), "text text")?,
            },
            "note" => ItemKind::Note {
                rect,
                text: multiline(field(fields, "text"), "note text")?,
            },
            "shape" => {
                let Some(shape) = field(fields, "shape").and_then(Value::as_str).and_then(Shape::parse) else {
                    return invalid("Unsupported shape.");
                };
                ItemKind::Shape {
                    rect,
                    shape,
                    text: multiline(field(fields, "text"), "shape text")?,
                }
            }
            "frame" => {
                let empty = Value::String(String::new());
                let title = match field(fields, "title") {
                    None | Some(Value::Null) => &empty,
                    Some(title) => title,
                };
                let mut title = text(Some(title), 100, "frame title")?;
                if title.is_empty() {
                    "Frame".clone_into(&mut title);
                }
                ItemKind::Frame { rect, title }
            }
            _ => {
                let Some(asset) = field(fields, "asset")
                    .and_then(Value::as_str)
                    .filter(|name| is_asset_name(name))
                else {
                    return invalid("Invalid image asset.");
                };
                ItemKind::Image {
                    rect,
                    asset: asset.to_owned(),
                }
            }
        }
    };
    let (color, font_size) = style(raw, item_type)?;
    let groups = groups(raw, version)?;
    Ok(Item {
        id,
        kind,
        color,
        font_size,
        groups,
    })
}

/// `ASSET_NAME`: a lowercase SHA-256 hex digest and an image extension.
pub fn is_asset_name(name: &str) -> bool {
    let Some((hash, extension)) = name.split_once('.') else {
        return false;
    };
    hash.len() == 64
        && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        && matches!(extension, "png" | "jpg" | "gif" | "webp")
}

/// Nested groups form a tree: every member of a group shares the same enclosing groups.
fn check_group_nesting<'a>(elements: impl IntoIterator<Item = &'a [String]>) -> Result<()> {
    let mut parents: HashMap<&str, String> = HashMap::new();
    for groups in elements {
        for (index, group) in groups.iter().enumerate() {
            let path = groups[..index].join("/");
            if parents.get(group.as_str()).is_some_and(|parent| *parent != path) {
                return invalid("Inconsistent group nesting.");
            }
            parents.insert(group.as_str(), path);
        }
    }
    Ok(())
}

/// Validates a workspace in format 1, 2, or 3 and returns it in the current format.
pub fn validate_workspace(raw: &Value) -> Result<Workspace> {
    let version = field(Some(raw), "version")
        .and_then(Value::as_f64)
        .filter(|v| [1.0, 2.0, 3.0].contains(v));
    let cards = field(Some(raw), "cards").and_then(Value::as_array);
    let (Some(version), Some(raw_cards)) = (version, cards) else {
        return invalid("Unsupported workspace format or too many terminals.");
    };
    let version = version as u32;
    let raw_items: &[Value] = match (version, field(Some(raw), "items")) {
        (1, _) | (_, None | Some(Value::Null)) => &[],
        (_, Some(Value::Array(items))) if items.len() <= limits::ITEMS => items,
        _ => return invalid("Invalid canvas items or too many items."),
    };
    let camera = field(Some(raw), "camera").filter(|camera| truthy(Some(camera)));
    let coordinate = |key| finite(field(camera, key), -limits::COORDINATE, limits::COORDINATE);
    let (Some(x), Some(y), Some(z)) = (coordinate("x"), coordinate("y"), finite(field(camera, "z"), 0.35, 1.5)) else {
        return invalid("Invalid canvas camera.");
    };
    let cards = raw_cards
        .iter()
        .map(|card| validate_card(card, version))
        .collect::<Result<Vec<_>>>()?;
    let mut ids: HashSet<&str> = cards.iter().map(|card| card.id.as_str()).collect();
    if ids.len() != cards.len() {
        return invalid("Duplicate terminal IDs.");
    }
    let items = raw_items
        .iter()
        .map(|item| validate_item(item, version))
        .collect::<Result<Vec<_>>>()?;
    for item in &items {
        if !ids.insert(item.id.as_str()) {
            return invalid("Duplicate canvas item IDs.");
        }
    }
    // Connectors may attach to any element except another line or themselves.
    let targets: HashSet<&str> = cards
        .iter()
        .map(|card| card.id.as_str())
        .chain(
            items
                .iter()
                .filter(|item| !matches!(item.kind, ItemKind::Line { .. }))
                .map(|item| item.id.as_str()),
        )
        .collect();
    for item in &items {
        if let ItemKind::Line { start, end, .. } = &item.kind {
            for endpoint in [start, end] {
                if let Endpoint::Element(id) = endpoint
                    && !targets.contains(id.as_str())
                {
                    return invalid("Connector references a missing item.");
                }
            }
        }
    }
    check_group_nesting(
        cards
            .iter()
            .map(|card| &card.groups[..])
            .chain(items.iter().map(|item| &item.groups[..])),
    )?;
    let mut name = text(field(Some(raw), "name"), 100, "workspace name")?;
    if name.is_empty() {
        "Untitled workspace".clone_into(&mut name);
    }
    Ok(Workspace {
        name,
        camera: Camera { x, y, z },
        cards,
        items,
    })
}

/// The workspace a new window starts with.
pub fn create_workspace() -> Workspace {
    Workspace {
        name: "My AI workspace".to_owned(),
        camera: Camera {
            x: 48.0,
            y: 48.0,
            z: 1.0,
        },
        cards: Vec::new(),
        items: Vec::new(),
    }
}

/// A new card from the UI's options: `profile`, `title`, `cwd`, `command`, `x`, and `y`.
pub fn create_card(options: &Value) -> Result<Card> {
    let option = |key| field(Some(options), key);
    let profile = option("profile")
        .and_then(Value::as_str)
        .and_then(ProfileId::parse)
        .unwrap_or(ProfileId::Shell)
        .profile();
    let or = |key, fallback: &str| {
        if truthy(option(key)) {
            option(key).cloned().unwrap_or_default()
        } else {
            Value::from(fallback)
        }
    };
    let unless_null = |key, fallback: Value| match option(key) {
        None | Some(Value::Null) => fallback,
        Some(value) => value.clone(),
    };
    let raw = json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "type": "terminal",
        "profile": profile.id.as_str(),
        "title": or("title", profile.name),
        "cwd": or("cwd", ""),
        "command": unless_null("command", Value::from(profile.command)),
        "x": unless_null("x", Value::from(0)),
        "y": unless_null("y", Value::from(0)),
        "w": 660,
        "h": 430,
    });
    validate_card(&raw, VERSION)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whole_number_versions_written_as_floats_are_accepted() {
        let board: Value =
            serde_json::from_str(r#"{"version":3.0,"name":"x","camera":{"x":0,"y":0,"z":1.0},"cards":[]}"#).unwrap();
        assert_eq!(
            validate_workspace(&board).unwrap().to_value()["camera"],
            json!({ "x": 0, "y": 0, "z": 1 })
        );
    }

    #[test]
    fn new_cards_follow_their_profile() {
        let claude = create_card(&json!({ "profile": "claude" })).unwrap();
        assert_eq!(
            (claude.title.as_str(), claude.command.as_str()),
            ("Claude Code", "claude")
        );
        assert_eq!(
            create_card(&json!({ "profile": "codex", "command": "" }))
                .unwrap()
                .command,
            ""
        );
        assert_eq!(create_card(&Value::Null).unwrap().profile, ProfileId::Shell);
        assert_eq!(
            create_card(&json!({ "profile": "nope", "title": "" })).unwrap().title,
            "Terminal"
        );
        assert!(uuid::Uuid::parse_str(&create_card(&json!({})).unwrap().id).is_ok());
        assert_eq!(
            create_card(&json!({ "title": 5 })).unwrap_err().to_string(),
            "Invalid title."
        );
        assert_eq!(
            create_card(&json!({ "command": "a\nb" })).unwrap_err().to_string(),
            "Invalid command."
        );
    }

    #[test]
    fn files_keep_the_field_order_and_put_embedded_images_last() {
        let mut assets = Map::new();
        assets.insert("a".into(), Value::from("data:"));
        let text = create_workspace().to_file_string(Some(&assets));
        let keys: Vec<String> = serde_json::from_str::<Map<String, Value>>(&text)
            .unwrap()
            .keys()
            .cloned()
            .collect();
        assert_eq!(keys, ["version", "name", "camera", "cards", "items", "assets"]);
        assert!(text.contains("\n  \"camera\": {\n    \"x\": 48,"));
    }
}
