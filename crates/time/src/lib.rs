//! OpenSesame's maintained date/time boundary.
//!
//! The implementation is backed by `time`, while the deliberately small API
//! preserves the persisted, signed, and wire representations used by the
//! native workspace.

mod datetime;
mod duration;
mod error;
mod format;
mod naive;
#[cfg(feature = "sqlx")]
mod sqlx;

pub use datetime::{DateTime, FixedOffset, LocalResult, TimeZone, Utc};
pub use duration::{Duration, Months};
pub use error::ParseError;
pub use format::{Formatted, SecondsFormat};
pub use naive::{NaiveDate, NaiveDateTime};

/// Historical name retained for the KeePass format boundary.
pub type TimeDelta = Duration;
