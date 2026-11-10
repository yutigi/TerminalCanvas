//! Terminal Canvas host logic that needs no UI and no child processes.
//!
//! Every module here is a port of a JavaScript module from the Electron host (see
//! `docs/rust-migration-plan.md`). Behavior, limits, and error messages match the JavaScript
//! code exactly, and the golden fixtures in `tests/golden/` prove it.

use std::fmt;
use std::io;

/// Defines a closed set of strings as an enum, such as item colors or providers.
macro_rules! string_enum {
    ($(#[$meta:meta])* $vis:vis enum $name:ident { $($variant:ident = $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        $vis enum $name { $($variant),+ }
        impl $name {
            /// Every value, in the order the JavaScript code lists them.
            pub const ALL: &'static [$name] = &[$($name::$variant),+];
            pub fn as_str(self) -> &'static str {
                match self { $($name::$variant => $text),+ }
            }
            #[allow(clippy::should_implement_trait)]
            pub fn parse(value: &str) -> Option<Self> {
                match value { $($text => Some($name::$variant),)+ _ => None }
            }
        }
        impl ::serde::Serialize for $name {
            fn serialize<S: ::serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(self.as_str())
            }
        }
        impl ::std::fmt::Display for $name {
            fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
                f.write_str(self.as_str())
            }
        }
    };
}

pub mod assets;
pub mod atomic;
pub mod dirs;
pub mod js;
pub mod node;
pub mod osc;
pub mod recovery;
pub mod session;
pub mod styles;
pub mod workspace;

/// An error the UI shows word for word, or a file system failure.
#[derive(Debug)]
pub enum Error {
    /// Rejected input. The message is the exact text the JavaScript host used.
    Invalid(String),
    Io(io::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Invalid(message) => f.write_str(message),
            Error::Io(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Invalid(_) => None,
            Error::Io(error) => Some(error),
        }
    }
}

impl From<io::Error> for Error {
    fn from(error: io::Error) -> Self {
        Error::Io(error)
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

pub(crate) fn invalid<T>(message: impl Into<String>) -> Result<T> {
    Err(Error::Invalid(message.into()))
}

/// The operating system rules a decoder applies. Fixtures name these the way Node does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Platform {
    Windows,
    MacOs,
    Linux,
    Other,
}

impl Platform {
    pub const fn current() -> Self {
        if cfg!(windows) {
            Platform::Windows
        } else if cfg!(target_os = "macos") {
            Platform::MacOs
        } else if cfg!(target_os = "linux") {
            Platform::Linux
        } else {
            Platform::Other
        }
    }

    /// Parses Node's `process.platform` names.
    pub fn from_node(name: &str) -> Self {
        match name {
            "win32" => Platform::Windows,
            "darwin" => Platform::MacOs,
            "linux" => Platform::Linux,
            _ => Platform::Other,
        }
    }

    pub fn is_windows(self) -> bool {
        self == Platform::Windows
    }
}
