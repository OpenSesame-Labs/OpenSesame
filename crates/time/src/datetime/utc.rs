use std::marker::PhantomData;

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
use time::OffsetDateTime;

use super::{DateTime, Utc};

impl Utc {
    #[must_use]
    #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
    pub fn now() -> DateTime<Self> {
        let now = OffsetDateTime::now_utc();
        DateTime::from_raw(now.unix_timestamp(), now.nanosecond(), 0).expect("system time in range")
    }

    #[must_use]
    #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
    pub fn now() -> DateTime<Self> {
        let milliseconds = js_sys::Date::now();
        assert!(milliseconds.is_finite(), "browser clock must be finite");
        #[allow(clippy::cast_possible_truncation)]
        DateTime::from_timestamp_millis(milliseconds as i64).expect("browser time in range")
    }
}

impl DateTime<Utc> {
    pub const UNIX_EPOCH: Self = Self {
        seconds: 0,
        nanos: 0,
        offset: 0,
        zone: PhantomData,
    };
    pub const MIN_UTC: Self = Self {
        seconds: Self::MIN_SECONDS,
        nanos: 0,
        offset: 0,
        zone: PhantomData,
    };
    pub const MAX_UTC: Self = Self {
        seconds: Self::MAX_SECONDS,
        nanos: 999_999_999,
        offset: 0,
        zone: PhantomData,
    };

    pub fn from_timestamp(seconds: i64, nanos: u32) -> Option<Self> {
        Self::from_raw(seconds, nanos, 0)
    }

    pub fn from_timestamp_millis(millis: i64) -> Option<Self> {
        Self::from_timestamp(
            millis.div_euclid(1_000),
            u32::try_from(millis.rem_euclid(1_000)).ok()? * 1_000_000,
        )
    }

    pub fn now_utc() -> Self {
        Utc::now()
    }
}
