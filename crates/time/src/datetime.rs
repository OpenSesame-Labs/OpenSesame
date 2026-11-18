use std::{fmt, marker::PhantomData};

mod traits;
mod utc;

use time::{
    macros::format_description, Date, Month, OffsetDateTime, PrimitiveDateTime, Time, UtcOffset,
};

use crate::{Duration, Formatted, Months, ParseError, SecondsFormat};

/// UTC marker.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub struct Utc;

/// A fixed numeric UTC offset.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub struct FixedOffset;

/// A single-valued local-time conversion result.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LocalResult<T>(Option<T>);

impl<T> LocalResult<T> {
    pub fn single(self) -> Option<T> {
        self.0
    }
    pub fn unwrap(self) -> T {
        self.0.expect("invalid or ambiguous local time")
    }
}

/// Minimal timezone operations used by the workspace.
pub trait TimeZone: Copy + fmt::Debug + Eq + 'static {
    fn offset_seconds(self) -> i32;
    fn is_utc() -> bool;
    fn canonical_offset(parsed: i32) -> i32;

    fn timestamp_opt(self, seconds: i64, nanos: u32) -> LocalResult<DateTime<Self>> {
        LocalResult(DateTime::from_raw(seconds, nanos, self.offset_seconds()))
    }

    fn with_ymd_and_hms(
        self,
        year: i32,
        month: u32,
        day: u32,
        hour: u32,
        minute: u32,
        second: u32,
    ) -> LocalResult<DateTime<Self>> {
        let value = u8::try_from(month)
            .ok()
            .and_then(|month| Month::try_from(month).ok())
            .and_then(|month| {
                Date::from_calendar_date(year, month, u8::try_from(day).unwrap_or(0)).ok()
            })
            .and_then(|date| {
                Time::from_hms(
                    u8::try_from(hour).unwrap_or(u8::MAX),
                    u8::try_from(minute).unwrap_or(u8::MAX),
                    u8::try_from(second).unwrap_or(u8::MAX),
                )
                .ok()
                .map(|time| PrimitiveDateTime::new(date, time))
            })
            .and_then(|naive| DateTime::from_local_primitive(naive, self));
        LocalResult(value)
    }

    fn datetime_from_utc(self, naive: &crate::NaiveDateTime) -> DateTime<Self> {
        DateTime::from_primitive(naive.0, self)
    }
}

impl TimeZone for Utc {
    fn offset_seconds(self) -> i32 {
        0
    }
    fn is_utc() -> bool {
        true
    }
    fn canonical_offset(_: i32) -> i32 {
        0
    }
}

impl TimeZone for FixedOffset {
    fn offset_seconds(self) -> i32 {
        0
    }
    fn is_utc() -> bool {
        false
    }
    fn canonical_offset(parsed: i32) -> i32 {
        parsed
    }
}

/// An absolute instant with a display offset.
#[derive(Clone, Copy)]
pub struct DateTime<Tz: TimeZone> {
    seconds: i64,
    nanos: u32,
    offset: i32,
    zone: PhantomData<Tz>,
}

impl<Tz: TimeZone> fmt::Debug for DateTime<Tz> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut value = self.to_rfc3339_opts(SecondsFormat::AutoSi, Tz::is_utc());

        // Chrono's `DateTime` debug representation joins the local naive
        // timestamp to the timezone offset's debug representation. RFC 3339
        // offsets are minute-aligned, but custom `TimeZone` implementations
        // can carry an offset with seconds, which Chrono preserves here.
        if !Tz::is_utc() && self.offset % 60 != 0 {
            value.truncate(value.len() - 6);
            let sign = if self.offset < 0 { '-' } else { '+' };
            let offset = self.offset.unsigned_abs();
            value.push_str(&format!(
                "{sign}{:02}:{:02}:{:02}",
                offset / 3_600,
                offset % 3_600 / 60,
                offset % 60
            ));
        }

        f.write_str(&value)
    }
}

impl<Tz: TimeZone> DateTime<Tz> {
    const MIN_SECONDS: i64 = -8_334_601_228_800;
    const MAX_SECONDS: i64 = 8_210_266_876_799;

    pub(crate) fn from_raw(seconds: i64, nanos: u32, offset: i32) -> Option<Self> {
        if !(Self::MIN_SECONDS..=Self::MAX_SECONDS).contains(&seconds)
            || nanos >= 2_000_000_000
            || (nanos >= 1_000_000_000 && seconds.rem_euclid(60) != 59)
            || UtcOffset::from_whole_seconds(offset).is_err()
        {
            return None;
        }
        OffsetDateTime::from_unix_timestamp(seconds).ok()?;
        Some(Self {
            seconds,
            nanos,
            offset,
            zone: PhantomData,
        })
    }

    pub(crate) fn from_primitive(value: PrimitiveDateTime, zone: Tz) -> Self {
        Self::from_local_primitive(value, zone).expect("valid primitive date/time")
    }

    fn from_local_primitive(value: PrimitiveDateTime, zone: Tz) -> Option<Self> {
        Self::from_local_primitive_with_offset(value, zone.offset_seconds())
    }

    fn from_local_primitive_with_offset(value: PrimitiveDateTime, seconds: i32) -> Option<Self> {
        let offset = UtcOffset::from_whole_seconds(seconds).ok()?;
        let at = value.assume_offset(offset);
        Self::from_raw(at.unix_timestamp(), at.nanosecond(), seconds)
    }

    fn total_nanos(self) -> i128 {
        i128::from(self.seconds) * 1_000_000_000 + i128::from(self.nanos)
    }

    pub(crate) fn as_offset_date_time(self) -> OffsetDateTime {
        OffsetDateTime::from_unix_timestamp_nanos(self.total_nanos())
            .expect("validated timestamp")
            .to_offset(UtcOffset::from_whole_seconds(self.offset).expect("validated offset"))
    }

    #[cfg(feature = "sqlx")]
    pub(crate) fn from_offset_date_time(value: OffsetDateTime) -> Option<Self> {
        Self::from_raw(
            value.unix_timestamp(),
            value.nanosecond(),
            value.offset().whole_seconds(),
        )
    }

    fn normalized(total: i128, offset: i32) -> Option<Self> {
        let seconds = i64::try_from(total.div_euclid(1_000_000_000)).ok()?;
        let nanos = u32::try_from(total.rem_euclid(1_000_000_000)).ok()?;
        Self::from_raw(seconds, nanos, offset)
    }

    fn local(self) -> OffsetDateTime {
        let base = OffsetDateTime::from_unix_timestamp(self.seconds).expect("validated timestamp");
        let base = base
            .replace_nanosecond(self.nanos.min(999_999_999))
            .expect("valid nanos");
        base.to_offset(UtcOffset::from_whole_seconds(self.offset).expect("validated offset"))
    }

    #[must_use]
    pub fn with_timezone<Other: TimeZone>(&self, zone: &Other) -> DateTime<Other> {
        DateTime {
            seconds: self.seconds,
            nanos: self.nanos,
            offset: zone.offset_seconds(),
            zone: PhantomData,
        }
    }

    pub const fn timestamp(&self) -> i64 {
        self.seconds
    }
    pub const fn timestamp_subsec_nanos(&self) -> u32 {
        self.nanos
    }
    pub fn timestamp_millis(&self) -> i64 {
        self.seconds * 1_000 + i64::from(self.nanos / 1_000_000)
    }
    pub fn timestamp_nanos_opt(&self) -> Option<i64> {
        i64::try_from(self.total_nanos()).ok()
    }

    #[must_use]
    pub fn naive_utc(&self) -> crate::NaiveDateTime {
        let value = self.as_offset_date_time().to_offset(UtcOffset::UTC);
        crate::NaiveDateTime(PrimitiveDateTime::new(value.date(), value.time()))
    }

    #[must_use]
    pub fn date_naive(&self) -> crate::NaiveDate {
        crate::NaiveDate(self.local().date())
    }

    pub fn signed_duration_since<Other: TimeZone>(self, rhs: DateTime<Other>) -> Duration {
        Duration::nanoseconds_i128(self.total_nanos() - rhs.total_nanos())
    }

    pub fn checked_add_signed(self, rhs: Duration) -> Option<Self> {
        Self::normalized(
            self.total_nanos().checked_add(rhs.whole_nanoseconds())?,
            self.offset,
        )
    }
    pub fn checked_sub_signed(self, rhs: Duration) -> Option<Self> {
        Self::normalized(
            self.total_nanos().checked_sub(rhs.whole_nanoseconds())?,
            self.offset,
        )
    }
    pub fn checked_add(self, rhs: Duration) -> Option<Self> {
        self.checked_add_signed(rhs)
    }
    pub fn checked_sub(self, rhs: Duration) -> Option<Self> {
        self.checked_sub_signed(rhs)
    }

    #[must_use]
    pub fn to_rfc3339(&self) -> String {
        self.to_rfc3339_opts(SecondsFormat::AutoSi, false)
    }

    #[must_use]
    pub fn to_rfc3339_opts(&self, precision: SecondsFormat, use_z: bool) -> String {
        let at = self.local();
        let year = crate::format::year(at.year());
        let second = if self.nanos >= 1_000_000_000 {
            60
        } else {
            at.second()
        };
        let fraction = self.nanos % 1_000_000_000;
        let digits = match precision {
            SecondsFormat::Secs => 0,
            SecondsFormat::Millis => 3,
            SecondsFormat::Micros => 6,
            SecondsFormat::Nanos => 9,
            SecondsFormat::AutoSi if fraction == 0 => 0,
            SecondsFormat::AutoSi if fraction.is_multiple_of(1_000_000) => 3,
            SecondsFormat::AutoSi if fraction.is_multiple_of(1_000) => 6,
            SecondsFormat::AutoSi => 9,
        };
        let mut value = format!(
            "{year}-{:02}-{:02}T{:02}:{:02}:{second:02}",
            u8::from(at.month()),
            at.day(),
            at.hour(),
            at.minute()
        );
        if digits != 0 {
            let divisor = 10_u32.pow(9 - digits);
            value.push_str(&format!(
                ".{:0width$}",
                fraction / divisor,
                width = digits as usize
            ));
        }
        if self.offset == 0 && use_z {
            value.push('Z');
        } else {
            let sign = if self.offset < 0 { '-' } else { '+' };
            let offset = self.offset.unsigned_abs();
            value.push_str(&format!(
                "{sign}{:02}:{:02}",
                offset / 3_600,
                offset % 3_600 / 60
            ));
        }
        value
    }

    #[must_use]
    pub fn format(&self, format: &str) -> Formatted {
        let at = self.local();
        let value = match format {
            "%Y%m%d%H%M%SZ" => at.format(format_description!(
                "[year][month][day][hour][minute][second]Z"
            )),
            "%Y-%m-%d %H:%M:%S%.6f" => at.format(format_description!(
                "[year]-[month]-[day] [hour]:[minute]:[second].[subsecond digits:6]"
            )),
            _ => at.format(format_description!(
                "[year]-[month]-[day]T[hour]:[minute]:[second]Z"
            )),
        }
        .unwrap_or_default();
        Formatted(value)
    }

    pub fn checked_sub_months(self, months: Months) -> Option<Self> {
        let at = self.local();
        let index = i64::from(at.year()) * 12 + i64::from(u8::from(at.month()) - 1)
            - i64::from(months.get());
        let year = i32::try_from(index.div_euclid(12)).ok()?;
        let month = Month::try_from(u8::try_from(index.rem_euclid(12) + 1).ok()?).ok()?;
        let mut day = at.day();
        let date = loop {
            if let Ok(date) = Date::from_calendar_date(year, month, day) {
                break date;
            }
            day = day.checked_sub(1)?;
        };
        Self::from_local_primitive_with_offset(PrimitiveDateTime::new(date, at.time()), self.offset)
    }
}

impl DateTime<FixedOffset> {
    pub fn parse_from_rfc3339(input: &str) -> Result<Self, ParseError> {
        parse_rfc3339(input)
    }
}

fn parse_rfc3339(input: &str) -> Result<DateTime<FixedOffset>, ParseError> {
    let leap = input.as_bytes().get(17..19) == Some(b"60");
    let relaxed_separator = input.as_bytes().get(10) == Some(&b' ');
    let owned = if leap || relaxed_separator {
        let mut bytes = input.as_bytes().to_vec();
        if leap {
            bytes[17..19].copy_from_slice(b"59");
        }
        if relaxed_separator {
            bytes[10] = b'T';
        }
        Some(String::from_utf8(bytes).map_err(|e| ParseError::new(e.to_string()))?)
    } else {
        None
    };
    let parse_input = owned.as_deref().unwrap_or(input);
    let parsed =
        OffsetDateTime::parse(parse_input, &time::format_description::well_known::Rfc3339)?;
    let nanos = parsed.nanosecond() + if leap { 1_000_000_000 } else { 0 };
    DateTime::from_raw(
        parsed.unix_timestamp(),
        nanos,
        parsed.offset().whole_seconds(),
    )
    .ok_or_else(|| ParseError::new("timestamp out of range"))
}
