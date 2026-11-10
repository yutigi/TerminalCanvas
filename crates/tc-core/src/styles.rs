//! Item style palettes and the group nesting limit, from `src/item-styles.js`.
//!
//! The renderer keeps using the JavaScript file. A parity test (`tests/item_styles_parity.rs`) loads it
//! with Node and compares it with these constants, so the two can never disagree.

string_enum! {
    /// An item color. An absent color is the default.
    pub enum Color {
        Red = "red",
        Orange = "orange",
        Yellow = "yellow",
        Green = "green",
        Blue = "blue",
        Purple = "purple",
        Gray = "gray",
    }
}

string_enum! {
    /// A text size. An absent size is the default, `medium`.
    pub enum FontSize {
        Small = "small",
        Large = "large",
        Huge = "huge",
    }
}

/// Item types that keep a color.
pub const COLORED_TYPES: [&str; 5] = ["text", "note", "shape", "frame", "line"];
/// Item types that keep a text size.
pub const TEXT_TYPES: [&str; 3] = ["text", "note", "shape"];
/// How deeply groups may nest.
pub const GROUP_DEPTH: usize = 8;
