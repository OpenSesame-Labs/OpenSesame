use opensesame_time::{DateTime, FixedOffset, Months, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use proptest::prelude::*;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

#[test]
fn rfc3339_fraction_offset_and_json_goldens() {
    for (input, display, canonical, json) in [
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
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(parsed.to_rfc3339(), display, "{input}");
        assert_eq!(
            parsed.to_rfc3339_opts(SecondsFormat::AutoSi, true),
            canonical,
            "{input}"
        );
        assert_eq!(serde_json::to_string(&parsed).unwrap(), json, "{input}");
    }
}

#[test]
fn debug_representation_matches_chrono_goldens() {
    for (input, expected) in [
        ("2030-01-01T00:00:00Z", "2030-01-01T00:00:00Z"),
        (
            "2026-09-22T15:30:00.123456789+05:30",
            "2026-09-22T15:30:00.123456789+05:30",
        ),
        ("1969-12-31T23:59:59-00:30", "1969-12-31T23:59:59-00:30"),
    ] {
        if input.ends_with('Z') {
            let value: DateTime<Utc> = input.parse().unwrap();
            assert_eq!(format!("{value:?}"), expected, "{input}");
        } else {
            let value: DateTime<FixedOffset> = input.parse().unwrap();
            assert_eq!(format!("{value:?}"), expected, "{input}");
        }
    }

    let before_common_era = DateTime::<Utc>::from_timestamp(-62_198_755_200, 0).unwrap();
    assert_eq!(format!("{before_common_era:?}"), "-0001-01-01T00:00:00Z");
}

#[test]
fn duration_bounds_match_the_retired_boundary() {
    let maximum_seconds = i64::MAX / 1_000;
    let minimum_seconds = i64::MIN / 1_000;
    assert!(opensesame_time::Duration::try_seconds(maximum_seconds).is_some());
    assert!(opensesame_time::Duration::try_seconds(maximum_seconds + 1).is_none());
    assert!(opensesame_time::Duration::try_seconds(minimum_seconds).is_some());
    assert!(opensesame_time::Duration::try_seconds(minimum_seconds - 1).is_none());
    assert!(std::panic::catch_unwind(|| { opensesame_time::Duration::seconds(i64::MAX) }).is_err());
    assert!(
        std::panic::catch_unwind(|| { opensesame_time::Duration::milliseconds(i64::MIN) }).is_err()
    );
    let maximum = opensesame_time::Duration::milliseconds(i64::MAX);
    assert_eq!(maximum.to_std().unwrap().as_millis(), i64::MAX as u128);
    assert!(opensesame_time::Duration::milliseconds(-1)
        .to_std()
        .is_err());
}

#[test]
fn timestamp_bounds_and_leap_validation_match_the_retired_boundary() {
    assert!(DateTime::<Utc>::from_timestamp(-8_334_601_228_800, 0).is_some());
    assert!(DateTime::<Utc>::from_timestamp(-8_334_601_228_801, 0).is_none());
    assert!(DateTime::<Utc>::from_timestamp(8_210_266_876_799, 1_999_999_999).is_some());
    assert_eq!(
        DateTime::<Utc>::MAX_UTC.timestamp_subsec_nanos(),
        999_999_999
    );
    assert!(DateTime::<Utc>::from_timestamp(8_210_266_876_800, 0).is_none());
    assert!(DateTime::<Utc>::from_timestamp(1_483_228_799, 1_123_456_789).is_some());
    assert!(DateTime::<Utc>::from_timestamp(1_483_228_798, 1_123_456_789).is_none());
}

#[test]
fn relaxed_rfc3339_separator_and_extended_year_formatting_match() {
    let relaxed = DateTime::parse_from_rfc3339("2015-02-18 23:59:60.234567+05:00")
        .unwrap()
        .with_timezone(&Utc);
    assert_eq!(relaxed.to_rfc3339(), "2015-02-18T18:59:60.234567+00:00");

    let before_common_era = DateTime::<Utc>::from_timestamp(-62_198_755_200, 0).unwrap();
    assert_eq!(before_common_era.to_rfc3339(), "-0001-01-01T00:00:00+00:00");
    let extended = DateTime::<Utc>::from_timestamp(253_402_300_800, 0).unwrap();
    assert_eq!(extended.to_rfc3339(), "+10000-01-01T00:00:00+00:00");
}

#[test]
fn calendar_month_subtraction_clamps_to_the_last_valid_day() {
    let march_end = DateTime::parse_from_rfc3339("2024-03-31T12:34:56Z")
        .unwrap()
        .with_timezone(&Utc);
    assert_eq!(
        march_end
            .checked_sub_months(Months::new(1))
            .unwrap()
            .to_rfc3339(),
        "2024-02-29T12:34:56+00:00"
    );
    let ordinary = DateTime::parse_from_rfc3339("2023-03-31T12:34:56Z")
        .unwrap()
        .with_timezone(&Utc);
    assert_eq!(
        ordinary
            .checked_sub_months(Months::new(1))
            .unwrap()
            .to_rfc3339(),
        "2023-02-28T12:34:56+00:00"
    );
}

#[test]
fn constructors_reject_invalid_or_out_of_range_values_without_panicking() {
    assert!(Utc
        .with_ymd_and_hms(2026, 13, 1, 0, 0, 0)
        .single()
        .is_none());
    assert!(Utc
        .with_ymd_and_hms(2026, 1, 1, 24, 0, 0)
        .single()
        .is_none());
    assert!(NaiveDateTime::parse_from_str("20260101x000000Z", "%Y%m%dT%H%M%SZ").is_err());
    assert!(NaiveDateTime::parse_from_str("999999-01-01T00:00:00", "%Y-%m-%dT%H:%M:%S").is_err());
}

#[test]
fn full_supported_range_converts_to_system_time() {
    let _: std::time::SystemTime = DateTime::<Utc>::MIN_UTC.into();
    let _: std::time::SystemTime = DateTime::<Utc>::MAX_UTC.into();
}

#[test]
fn equal_leap_second_representations_hash_identically() {
    let leap = DateTime::<Utc>::from_timestamp(1_483_228_799, 1_000_000_000).unwrap();
    let following = DateTime::<Utc>::from_timestamp(1_483_228_800, 0).unwrap();
    assert_eq!(leap, following);
    let digest = |value: DateTime<Utc>| {
        let mut hasher = DefaultHasher::new();
        value.hash(&mut hasher);
        hasher.finish()
    };
    assert_eq!(digest(leap), digest(following));
}

#[test]
fn leap_second_golden() {
    let leap = DateTime::parse_from_rfc3339("2016-12-31T23:59:60.123456789Z")
        .unwrap()
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
    fn rfc3339_and_json_round_trip(
        seconds in -62_135_596_800_i64..253_402_300_799_i64,
        nanos in prop::sample::select(vec![0_u32, 100_000_000, 123_000_000, 123_456_000, 123_456_789]),
    ) {
        let value = DateTime::<Utc>::from_timestamp(seconds, nanos).unwrap();
        let wire = value.to_rfc3339_opts(SecondsFormat::AutoSi, true);
        let reparsed = DateTime::parse_from_rfc3339(&wire).unwrap().with_timezone(&Utc);
        prop_assert_eq!(reparsed, value);
        let json = serde_json::to_string(&value).unwrap();
        let decoded: DateTime<Utc> = serde_json::from_str(&json).unwrap();
        prop_assert_eq!(decoded, value);
    }
}
