use std::{
    cmp::Ordering,
    fmt,
    hash::{Hash, Hasher},
    marker::PhantomData,
    ops::{Add, AddAssign, Sub, SubAssign},
    str::FromStr,
};

use crate::{Duration, ParseError, SecondsFormat};

use super::{parse_rfc3339, DateTime, FixedOffset, TimeZone, Utc};

impl Default for DateTime<Utc> {
    fn default() -> Self {
        Self::UNIX_EPOCH
    }
}

impl Default for DateTime<FixedOffset> {
    fn default() -> Self {
        Self::from_raw(0, 0, 0).expect("epoch is valid")
    }
}

impl<Tz: TimeZone> PartialEq for DateTime<Tz> {
    fn eq(&self, rhs: &Self) -> bool {
        self.total_nanos() == rhs.total_nanos()
    }
}

impl<Tz: TimeZone> Eq for DateTime<Tz> {}

impl<Tz: TimeZone> Hash for DateTime<Tz> {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.total_nanos().hash(state);
    }
}

impl<Tz: TimeZone> PartialOrd for DateTime<Tz> {
    fn partial_cmp(&self, rhs: &Self) -> Option<Ordering> {
        Some(self.cmp(rhs))
    }
}

impl<Tz: TimeZone> Ord for DateTime<Tz> {
    fn cmp(&self, rhs: &Self) -> Ordering {
        self.total_nanos().cmp(&rhs.total_nanos())
    }
}

impl<Tz: TimeZone> Add<Duration> for DateTime<Tz> {
    type Output = Self;

    fn add(self, rhs: Duration) -> Self {
        self.checked_add(rhs).expect("date/time overflow")
    }
}

impl<Tz: TimeZone> Sub<Duration> for DateTime<Tz> {
    type Output = Self;

    fn sub(self, rhs: Duration) -> Self {
        self.checked_sub(rhs).expect("date/time overflow")
    }
}

impl<Tz: TimeZone> Sub for DateTime<Tz> {
    type Output = Duration;

    fn sub(self, rhs: Self) -> Duration {
        self.signed_duration_since(rhs)
    }
}

impl<Tz: TimeZone> AddAssign<Duration> for DateTime<Tz> {
    fn add_assign(&mut self, rhs: Duration) {
        *self = *self + rhs;
    }
}

impl<Tz: TimeZone> SubAssign<Duration> for DateTime<Tz> {
    fn sub_assign(&mut self, rhs: Duration) {
        *self = *self - rhs;
    }
}

impl<Tz: TimeZone> fmt::Display for DateTime<Tz> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_rfc3339())
    }
}

impl<Tz: TimeZone> From<DateTime<Tz>> for std::time::SystemTime {
    fn from(value: DateTime<Tz>) -> Self {
        let nanos = value.total_nanos();
        let magnitude = nanos.unsigned_abs();
        let duration = std::time::Duration::new(
            u64::try_from(magnitude / 1_000_000_000).expect("timestamp seconds fit SystemTime"),
            u32::try_from(magnitude % 1_000_000_000).expect("subsecond nanoseconds are valid"),
        );
        if nanos >= 0 {
            Self::UNIX_EPOCH + duration
        } else {
            Self::UNIX_EPOCH - duration
        }
    }
}

impl From<std::time::SystemTime> for DateTime<Utc> {
    fn from(value: std::time::SystemTime) -> Self {
        let nanos = match value.duration_since(std::time::SystemTime::UNIX_EPOCH) {
            Ok(duration) => i128::try_from(duration.as_nanos()).expect("system timestamp in range"),
            Err(error) => {
                -i128::try_from(error.duration().as_nanos()).expect("system timestamp in range")
            }
        };
        Self::normalized(nanos, 0).expect("system timestamp in supported range")
    }
}

impl<Tz: TimeZone> FromStr for DateTime<Tz> {
    type Err = ParseError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let parsed = parse_rfc3339(value)?;
        Ok(DateTime {
            seconds: parsed.seconds,
            nanos: parsed.nanos,
            offset: Tz::canonical_offset(parsed.offset),
            zone: PhantomData,
        })
    }
}

impl<Tz: TimeZone> serde::Serialize for DateTime<Tz> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_rfc3339_opts(SecondsFormat::AutoSi, self.offset == 0))
    }
}

impl<'de, Tz: TimeZone> serde::Deserialize<'de> for DateTime<Tz> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = <String as serde::Deserialize>::deserialize(deserializer)?;
        raw.parse().map_err(serde::de::Error::custom)
    }
}
