use std::fmt;

/// Fractional-second policy for RFC 3339 output.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SecondsFormat {
    AutoSi,
    Millis,
    Micros,
    Nanos,
    Secs,
}

/// Lazily displayable formatted date/time text.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Formatted(pub(crate) String);

pub(crate) fn year(value: i32) -> String {
    if value < 0 {
        format!("-{:04}", value.unsigned_abs())
    } else if value > 9_999 {
        format!("+{value}")
    } else {
        format!("{value:04}")
    }
}

impl fmt::Display for Formatted {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
