use std::fmt;

/// A date/time value could not be parsed or represented.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParseError(pub(crate) String);

impl ParseError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ParseError {}

impl From<time::error::Parse> for ParseError {
    fn from(value: time::error::Parse) -> Self {
        Self(value.to_string())
    }
}

impl From<time::error::ComponentRange> for ParseError {
    fn from(value: time::error::ComponentRange) -> Self {
        Self(value.to_string())
    }
}
