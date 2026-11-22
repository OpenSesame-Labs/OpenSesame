use sqlx_core::{
    database::Database,
    decode::Decode,
    encode::{Encode, IsNull},
    error::BoxDynError,
    type_info::TypeInfo,
    types::Type,
    value::ValueRef,
};
use sqlx_postgres::{PgArgumentBuffer, PgHasArrayType, PgTypeInfo, PgValueRef, Postgres};
use sqlx_sqlite::{Sqlite, SqliteArgumentsBuffer, SqliteTypeInfo, SqliteValueRef};
use time::OffsetDateTime;

use crate::{DateTime, SecondsFormat, TimeZone, Utc};

impl<Tz: TimeZone> Type<Postgres> for DateTime<Tz> {
    fn type_info() -> PgTypeInfo {
        <OffsetDateTime as Type<Postgres>>::type_info()
    }

    fn compatible(ty: &PgTypeInfo) -> bool {
        <OffsetDateTime as Type<Postgres>>::compatible(ty)
    }
}

impl<Tz: TimeZone> PgHasArrayType for DateTime<Tz> {
    fn array_type_info() -> PgTypeInfo {
        <OffsetDateTime as PgHasArrayType>::array_type_info()
    }
}

impl<Tz: TimeZone> Encode<'_, Postgres> for DateTime<Tz> {
    fn encode_by_ref(&self, buf: &mut PgArgumentBuffer) -> Result<IsNull, BoxDynError> {
        <OffsetDateTime as Encode<'_, Postgres>>::encode(self.as_offset_date_time(), buf)
    }

    fn produces(&self) -> Option<PgTypeInfo> {
        <OffsetDateTime as Encode<'_, Postgres>>::produces(&self.as_offset_date_time())
    }

    fn size_hint(&self) -> usize {
        <OffsetDateTime as Encode<'_, Postgres>>::size_hint(&self.as_offset_date_time())
    }
}

impl<'r, Tz: TimeZone> Decode<'r, Postgres> for DateTime<Tz> {
    fn decode(value: PgValueRef<'r>) -> Result<Self, BoxDynError> {
        let value = <OffsetDateTime as Decode<'r, Postgres>>::decode(value)?;
        Self::from_offset_date_time(value)
            .ok_or_else(|| "PostgreSQL timestamp is outside the supported date/time range".into())
    }
}

impl<Tz: TimeZone> Type<Sqlite> for DateTime<Tz> {
    fn type_info() -> SqliteTypeInfo {
        <String as Type<Sqlite>>::type_info()
    }

    fn compatible(ty: &SqliteTypeInfo) -> bool {
        <String as Type<Sqlite>>::compatible(ty)
            || <i64 as Type<Sqlite>>::compatible(ty)
            || <f64 as Type<Sqlite>>::compatible(ty)
    }
}

impl<Tz: TimeZone> Encode<'_, Sqlite> for DateTime<Tz> {
    fn encode_by_ref(&self, buf: &mut SqliteArgumentsBuffer) -> Result<IsNull, BoxDynError> {
        <String as Encode<'_, Sqlite>>::encode(
            self.to_rfc3339_opts(SecondsFormat::AutoSi, false),
            buf,
        )
    }

    fn produces(&self) -> Option<SqliteTypeInfo> {
        None
    }

    fn size_hint(&self) -> usize {
        self.to_rfc3339_opts(SecondsFormat::AutoSi, false).len()
    }
}

impl<'r, Tz: TimeZone + Default> Decode<'r, Sqlite> for DateTime<Tz> {
    fn decode(value: SqliteValueRef<'r>) -> Result<Self, BoxDynError> {
        match value.type_info().name() {
            "TEXT" => {
                let raw = <String as Decode<'r, Sqlite>>::decode(value)?;
                if let Ok(parsed) = raw.parse::<Self>() {
                    return Ok(parsed);
                }
                let naive = crate::NaiveDateTime::parse_from_str(&raw, "%Y-%m-%d %H:%M:%S%.f")?;
                Ok(Tz::default().datetime_from_utc(&naive))
            }
            "INTEGER" | "INT4" => {
                let seconds = <i64 as Decode<'r, Sqlite>>::decode(value)?;
                let utc = DateTime::<Utc>::from_timestamp(seconds, 0)
                    .ok_or_else(|| format!("invalid datetime integer: {seconds}"))?;
                Ok(utc.with_timezone(&Tz::default()))
            }
            "REAL" => {
                let julian = <f64 as Decode<'r, Sqlite>>::decode(value)?;
                let utc = decode_julian_day(julian)
                    .ok_or_else(|| format!("invalid datetime float: {julian}"))?;
                Ok(utc.with_timezone(&Tz::default()))
            }
            kind => Err(format!("invalid datetime SQLite type: {kind}").into()),
        }
    }
}

fn decode_julian_day(julian: f64) -> Option<DateTime<Utc>> {
    let timestamp = (julian - 2_440_587.5) * 86_400.0;
    if !timestamp.is_finite() {
        return None;
    }
    let seconds = timestamp.floor();
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    DateTime::from_timestamp(seconds as i64, ((timestamp - seconds) * 1E9) as u32)
}

const _: fn() = || {
    fn assert_database<DB: Database>() {}
    assert_database::<Postgres>();
    assert_database::<Sqlite>();
};

#[cfg(test)]
mod tests {
    use super::decode_julian_day;

    #[test]
    fn negative_fractional_julian_day_stays_before_the_epoch() {
        let half_second_before_epoch = 2_440_587.5 - 0.5 / 86_400.0;
        let decoded = decode_julian_day(half_second_before_epoch).unwrap();
        assert_eq!(decoded.timestamp(), -1);
        assert!((400_000_000..600_000_000).contains(&decoded.timestamp_subsec_nanos()));
    }
}
