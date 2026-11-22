use std::{
    fmt,
    ops::{Add, Sub},
    str::FromStr,
};

use time::{macros::format_description, Date, PrimitiveDateTime, Time};

use crate::{DateTime, Duration, Formatted, ParseError, Utc};

/// A calendar date and wall-clock time without an offset.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct NaiveDateTime(pub(crate) PrimitiveDateTime);

impl NaiveDateTime {
    pub fn parse_from_str(input: &str, format: &str) -> Result<Self, ParseError> {
        let compact;
        let with_seconds;
        let input = match format {
            "%Y%m%dT%H%M%SZ" => {
                if !valid_compact(input) {
                    return Err(ParseError::new("invalid compact UTC timestamp"));
                }
                compact = format!(
                    "{}-{}-{}T{}:{}:{}",
                    &input[0..4],
                    &input[4..6],
                    &input[6..8],
                    &input[9..11],
                    &input[11..13],
                    &input[13..15]
                );
                compact.as_str()
            }
            "%Y-%m-%dT%H:%MZ" => {
                let Some(value) = input.strip_suffix('Z') else {
                    return Err(ParseError::new("UTC timestamp must end in Z"));
                };
                if !valid_separated(value, b'T', false, false) {
                    return Err(ParseError::new("invalid minute-precision timestamp"));
                }
                with_seconds = format!("{value}:00");
                with_seconds.as_str()
            }
            "%Y-%m-%dT%H:%M:%SZ" => {
                let Some(value) = input.strip_suffix('Z') else {
                    return Err(ParseError::new("UTC timestamp must end in Z"));
                };
                if !valid_separated(value, b'T', true, false) {
                    return Err(ParseError::new("invalid UTC timestamp"));
                }
                value
            }
            "%Y-%m-%dT%H:%M:%S" => {
                if !valid_separated(input, b'T', true, false) {
                    return Err(ParseError::new("invalid timestamp"));
                }
                input
            }
            "%Y-%m-%d %H:%M:%S%.f" => {
                if !valid_separated(input, b' ', true, true) {
                    return Err(ParseError::new("invalid fractional timestamp"));
                }
                input
            }
            "%Y-%m-%dT%H:%M:%S%.f" => {
                if !valid_separated(input, b'T', true, true) {
                    return Err(ParseError::new("invalid fractional timestamp"));
                }
                input
            }
            _ => return Err(ParseError::new("unsupported date/time format")),
        };
        let normalized = input.replace(' ', "T");
        let plain = format_description!("[year]-[month]-[day]T[hour]:[minute]:[second]");
        let fractional =
            format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond]");
        let parsed = PrimitiveDateTime::parse(&normalized, fractional)
            .or_else(|_| PrimitiveDateTime::parse(&normalized, plain))?;
        if chrono_year(parsed.date().year()) {
            Ok(Self(parsed))
        } else {
            Err(ParseError::new("timestamp out of range"))
        }
    }

    fn checked(value: PrimitiveDateTime) -> Option<Self> {
        chrono_year(value.date().year()).then_some(Self(value))
    }

    #[must_use]
    pub fn and_utc(self) -> DateTime<Utc> {
        DateTime::from_primitive(self.0, Utc)
    }

    pub fn checked_add_signed(self, duration: Duration) -> Option<Self> {
        let total = self
            .0
            .assume_utc()
            .unix_timestamp_nanos()
            .checked_add(duration.whole_nanoseconds())?;
        let value = time::OffsetDateTime::from_unix_timestamp_nanos(total).ok()?;
        Self::checked(PrimitiveDateTime::new(value.date(), value.time()))
    }

    #[must_use]
    pub fn format(self, format: &str) -> Formatted {
        let text = match format {
            "%Y-%m-%dT%H:%M:%SZ" => self.0.format(format_description!(
                "[year]-[month]-[day]T[hour]:[minute]:[second]Z"
            )),
            _ => self.0.format(format_description!(
                "[year]-[month]-[day]T[hour]:[minute]:[second]"
            )),
        }
        .unwrap_or_default();
        Formatted(text)
    }
}

impl Default for NaiveDateTime {
    fn default() -> Self {
        Self(PrimitiveDateTime::new(
            Date::from_calendar_date(1970, time::Month::January, 1).expect("epoch is valid"),
            Time::MIDNIGHT,
        ))
    }
}

impl fmt::Display for NaiveDateTime {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.format("%Y-%m-%dT%H:%M:%S"))
    }
}

impl FromStr for NaiveDateTime {
    type Err = ParseError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse_from_str(value, "%Y-%m-%dT%H:%M:%S")
    }
}

impl Add<Duration> for NaiveDateTime {
    type Output = Self;
    fn add(self, rhs: Duration) -> Self::Output {
        self.checked_add_signed(rhs).expect("date/time overflow")
    }
}

impl Sub for NaiveDateTime {
    type Output = Duration;
    fn sub(self, rhs: Self) -> Self::Output {
        Duration::nanoseconds_i128(
            self.0.assume_utc().unix_timestamp_nanos() - rhs.0.assume_utc().unix_timestamp_nanos(),
        )
    }
}

impl serde::Serialize for NaiveDateTime {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> serde::Deserialize<'de> for NaiveDateTime {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = <String as serde::Deserialize>::deserialize(deserializer)?;
        raw.parse().map_err(serde::de::Error::custom)
    }
}

/// A calendar date without a time or offset.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct NaiveDate(pub(crate) Date);

impl NaiveDate {
    pub fn parse_from_str(input: &str, format: &str) -> Result<Self, ParseError> {
        if format != "%Y-%m-%d" || !valid_date(input) {
            return Err(ParseError::new("invalid date"));
        }
        let date = Date::parse(input, format_description!("[year]-[month]-[day]"))?;
        if chrono_year(date.year()) {
            Ok(Self(date))
        } else {
            Err(ParseError::new("date out of range"))
        }
    }

    #[must_use]
    pub fn and_hms_opt(self, hour: u32, minute: u32, second: u32) -> Option<NaiveDateTime> {
        let time = Time::from_hms(
            u8::try_from(hour).ok()?,
            u8::try_from(minute).ok()?,
            u8::try_from(second).ok()?,
        )
        .ok()?;
        NaiveDateTime::checked(PrimitiveDateTime::new(self.0, time))
    }
}

fn chrono_year(year: i32) -> bool {
    (-262_143..=262_142).contains(&year)
}

fn valid_date(input: &str) -> bool {
    let bytes = input.as_bytes();
    bytes.len() == 10
        && input.is_ascii()
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
}

fn valid_compact(input: &str) -> bool {
    let bytes = input.as_bytes();
    bytes.len() == 16
        && input.is_ascii()
        && bytes[8] == b'T'
        && bytes[15] == b'Z'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 8 | 15) || byte.is_ascii_digit())
}

fn valid_separated(input: &str, separator: u8, seconds: bool, fraction: bool) -> bool {
    let bytes = input.as_bytes();
    let required = if seconds { 19 } else { 16 };
    if !input.is_ascii() || bytes.len() < required || (!fraction && bytes.len() != required) {
        return false;
    }
    let punctuation = [(4, b'-'), (7, b'-'), (10, separator), (13, b':')];
    if punctuation
        .iter()
        .any(|&(index, expected)| bytes[index] != expected)
        || (seconds && bytes[16] != b':')
    {
        return false;
    }
    let digits = bytes[..required]
        .iter()
        .enumerate()
        .all(|(index, byte)| matches!(index, 4 | 7 | 10 | 13 | 16) || byte.is_ascii_digit());
    digits
        && (bytes.len() == required
            || (fraction
                && bytes[required] == b'.'
                && bytes[required + 1..].iter().all(u8::is_ascii_digit)
                && bytes.len() > required + 1))
}
