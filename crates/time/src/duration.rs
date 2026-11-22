use std::ops::{Add, Mul, Neg, Sub};

/// A signed, nanosecond-precision span.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct Duration(i128);

impl Duration {
    const NANOS_PER_MILLI: i128 = 1_000_000;
    const NANOS_PER_SECOND: i128 = 1_000_000_000;
    const MIN_NANOS: i128 = -(i64::MAX as i128) * Self::NANOS_PER_MILLI;
    const MAX_NANOS: i128 = (i64::MAX as i128) * Self::NANOS_PER_MILLI;

    const fn checked_nanos(value: i128) -> Option<Self> {
        if value < Self::MIN_NANOS || value > Self::MAX_NANOS {
            None
        } else {
            Some(Self(value))
        }
    }

    pub const fn zero() -> Self {
        Self(0)
    }

    pub const fn seconds(value: i64) -> Self {
        match Self::try_seconds(value) {
            Some(duration) => duration,
            None => panic!("Duration::seconds out of bounds"),
        }
    }

    pub const fn minutes(value: i64) -> Self {
        match value.checked_mul(60) {
            Some(seconds) => Self::seconds(seconds),
            None => panic!("Duration::minutes out of bounds"),
        }
    }

    pub const fn hours(value: i64) -> Self {
        match value.checked_mul(60) {
            Some(minutes) => Self::minutes(minutes),
            None => panic!("Duration::hours out of bounds"),
        }
    }

    pub const fn days(value: i64) -> Self {
        match value.checked_mul(24) {
            Some(hours) => Self::hours(hours),
            None => panic!("Duration::days out of bounds"),
        }
    }

    pub const fn milliseconds(value: i64) -> Self {
        match Self::checked_nanos(value as i128 * Self::NANOS_PER_MILLI) {
            Some(duration) => duration,
            None => panic!("Duration::milliseconds out of bounds"),
        }
    }

    pub const fn try_seconds(value: i64) -> Option<Self> {
        Self::checked_nanos(value as i128 * Self::NANOS_PER_SECOND)
    }

    pub fn from_std(value: std::time::Duration) -> Result<Self, time::error::ConversionRange> {
        let nanos = i128::try_from(value.as_nanos()).map_err(|_| time::error::ConversionRange)?;
        Self::checked_nanos(nanos).ok_or(time::error::ConversionRange)
    }

    pub fn to_std(self) -> Result<std::time::Duration, time::error::ConversionRange> {
        let seconds = u64::try_from(self.0 / Self::NANOS_PER_SECOND)
            .map_err(|_| time::error::ConversionRange)?;
        let nanos = u32::try_from(self.0 % Self::NANOS_PER_SECOND)
            .map_err(|_| time::error::ConversionRange)?;
        Ok(std::time::Duration::new(seconds, nanos))
    }

    pub const fn num_seconds(self) -> i64 {
        (self.0 / 1_000_000_000) as i64
    }

    pub const fn num_milliseconds(self) -> i64 {
        (self.0 / 1_000_000) as i64
    }

    pub const fn num_days(self) -> i64 {
        self.num_seconds() / 86_400
    }

    pub const fn checked_mul(self, rhs: i32) -> Option<Self> {
        let value = match self.0.checked_mul(rhs as i128) {
            Some(value) => value,
            None => return None,
        };
        Self::checked_nanos(value)
    }

    pub(crate) const fn whole_nanoseconds(self) -> i128 {
        self.0
    }

    pub(crate) const fn nanoseconds_i128(value: i128) -> Self {
        match Self::checked_nanos(value) {
            Some(duration) => duration,
            None => panic!("Duration out of bounds"),
        }
    }
}

impl Add for Duration {
    type Output = Self;
    fn add(self, rhs: Self) -> Self::Output {
        match self.0.checked_add(rhs.0).and_then(Self::checked_nanos) {
            Some(duration) => duration,
            None => panic!("Duration addition out of bounds"),
        }
    }
}

impl Sub for Duration {
    type Output = Self;
    fn sub(self, rhs: Self) -> Self::Output {
        match self.0.checked_sub(rhs.0).and_then(Self::checked_nanos) {
            Some(duration) => duration,
            None => panic!("Duration subtraction out of bounds"),
        }
    }
}

impl Neg for Duration {
    type Output = Self;
    fn neg(self) -> Self::Output {
        match self.0.checked_neg().and_then(Self::checked_nanos) {
            Some(duration) => duration,
            None => panic!("Duration negation out of bounds"),
        }
    }
}

impl Mul<i32> for Duration {
    type Output = Self;
    fn mul(self, rhs: i32) -> Self::Output {
        match self.checked_mul(rhs) {
            Some(duration) => duration,
            None => panic!("Duration multiplication out of bounds"),
        }
    }
}

/// A calendar-month count used only for explicit calendar arithmetic.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Months(u32);

impl Months {
    pub const fn new(value: u32) -> Self {
        Self(value)
    }

    pub(crate) const fn get(self) -> u32 {
        self.0
    }
}
