//! Golden and property coverage for the date/time representation boundary.
//!
//! These expectations deliberately capture Chrono's externally observable
//! behavior before the maintained date/time implementation replaces it.

use opensesame_time::{DateTime, SecondsFormat, Utc};
use proptest::prelude::*;

#[test]
fn rfc3339_fraction_and_offset_goldens() {
    for (input, display, canonical_utc, serde_json) in [
        (
            "2026-09-22T10:00:00Z",
            "2026-09-22T10:00:00+00:00",
            "2026-09-22T10:00:00Z",
            "\"2026-09-22T10:00:00Z\"",
        ),
        (
            "2026-09-22T10:00:00.1Z",
            "2026-09-22T10:00:00.100+00:00",
            "2026-09-22T10:00:00.100Z",
            "\"2026-09-22T10:00:00.100Z\"",
        ),
        (
            "2026-09-22T10:00:00.123456Z",
            "2026-09-22T10:00:00.123456+00:00",
            "2026-09-22T10:00:00.123456Z",
            "\"2026-09-22T10:00:00.123456Z\"",
        ),
        (
            "2026-09-22T15:30:00.123456789+05:30",
            "2026-09-22T10:00:00.123456789+00:00",
            "2026-09-22T10:00:00.123456789Z",
            "\"2026-09-22T10:00:00.123456789Z\"",
        ),
    ] {
        let parsed = DateTime::parse_from_rfc3339(input)
            .expect("valid RFC 3339")
            .with_timezone(&Utc);
        assert_eq!(parsed.to_rfc3339(), display, "{input}");
        assert_eq!(
            parsed.to_rfc3339_opts(SecondsFormat::AutoSi, true),
            canonical_utc,
            "{input}"
        );
        assert_eq!(
            serde_json::to_string(&parsed).unwrap(),
            serde_json,
            "{input}"
        );
    }
}

#[test]
fn leap_second_input_and_formatting_golden() {
    let leap = DateTime::parse_from_rfc3339("2016-12-31T23:59:60.123456789Z")
        .expect("Chrono accepts an RFC 3339 leap second")
        .with_timezone(&Utc);

    assert_eq!(leap.timestamp(), 1_483_228_799);
    assert_eq!(leap.timestamp_subsec_nanos(), 1_123_456_789);
    assert_eq!(leap.to_rfc3339(), "2016-12-31T23:59:60.123456789+00:00");
    assert_eq!(
        serde_json::to_string(&leap).unwrap(),
        "\"2016-12-31T23:59:60.123456789Z\""
    );
}

proptest! {
    #[test]
    fn utc_rfc3339_and_json_round_trip(
        seconds in -62_135_596_800_i64..253_402_300_799_i64,
        nanos in prop::sample::select(vec![0_u32, 100_000_000, 123_000_000, 123_456_000, 123_456_789]),
    ) {
        let value = DateTime::<Utc>::from_timestamp(seconds, nanos).expect("generated instant is in range");
        let wire = value.to_rfc3339_opts(SecondsFormat::AutoSi, true);
        let reparsed = DateTime::parse_from_rfc3339(&wire).unwrap().with_timezone(&Utc);
        prop_assert_eq!(reparsed, value);

        let json = serde_json::to_string(&value).unwrap();
        let decoded: DateTime<Utc> = serde_json::from_str(&json).unwrap();
        prop_assert_eq!(decoded, value);
    }
}
