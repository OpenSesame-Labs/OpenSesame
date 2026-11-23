//! The opaque push's wire shape, decoded strictly.
//!
//! `{"blobs":[{"id","epoch","ciphertext"}]}` is the whole of it. A field that
//! is not one of those is refused while the body is decoded — one named like
//! plaintext or a seal as `plaintext_or_seal_field_forbidden`, any other as
//! `invalid_sync_blobs` — so the route never holds untyped JSON to walk.

use std::fmt;

use axum::{extract::rejection::JsonRejection, http::StatusCode, Json};
use serde::de::{self, Deserialize, Deserializer, MapAccess, Visitor};

use super::{smuggles_plaintext, OpaqueSyncBlobDto};

/// The refusal for a field that smuggles plaintext or a seal.
pub(super) const PLAINTEXT_FORBIDDEN: &str = "plaintext_or_seal_field_forbidden";

const BODY_FIELDS: &[&str] = &["blobs"];
const BLOB_FIELDS: &[&str] = &["id", "epoch", "ciphertext"];

/// `{"blobs": [...]}` and nothing else.
#[derive(Debug)]
pub struct SyncPushOpaqueBody {
    pub(super) blobs: Vec<OpaqueSyncBlobDto>,
}

/// One blob, `{"id","epoch","ciphertext"}` and nothing else.
struct StrictBlob(OpaqueSyncBlobDto);

/// The decoded push, or the status and closed code it is refused with.
pub(super) fn opaque_push_body(
    body: Result<Json<SyncPushOpaqueBody>, JsonRejection>,
) -> Result<SyncPushOpaqueBody, (StatusCode, &'static str)> {
    match body {
        Ok(Json(body)) => Ok(body),
        Err(JsonRejection::JsonDataError(error))
            if error.body_text().contains(PLAINTEXT_FORBIDDEN) =>
        {
            Err((StatusCode::BAD_REQUEST, PLAINTEXT_FORBIDDEN))
        }
        Err(JsonRejection::BytesRejection(_)) => {
            Err((StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large"))
        }
        Err(JsonRejection::MissingJsonContentType(_)) => {
            Err((StatusCode::UNSUPPORTED_MEDIA_TYPE, "invalid_sync_blobs"))
        }
        Err(_) => Err((StatusCode::BAD_REQUEST, "invalid_sync_blobs")),
    }
}

/// Which of `known` this field is; a smuggled or unknown name is an error.
fn field<E: de::Error>(key: &str, known: &'static [&'static str]) -> Result<usize, E> {
    if let Some(index) = known.iter().position(|name| *name == key) {
        return Ok(index);
    }
    if smuggles_plaintext(key) {
        return Err(E::custom(PLAINTEXT_FORBIDDEN));
    }
    Err(E::unknown_field(key, known))
}

/// Fill `slot` with the next value, refusing a field named twice.
fn fill<'de, A: MapAccess<'de>, T: Deserialize<'de>>(
    map: &mut A,
    slot: &mut Option<T>,
    name: &'static str,
) -> Result<(), A::Error> {
    if slot.is_some() {
        return Err(de::Error::duplicate_field(name));
    }
    *slot = Some(map.next_value()?);
    Ok(())
}

struct BodyVisitor;

impl<'de> Visitor<'de> for BodyVisitor {
    type Value = SyncPushOpaqueBody;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("an opaque sync push")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut blobs: Option<Vec<StrictBlob>> = None;
        while let Some(key) = map.next_key::<String>()? {
            field::<A::Error>(&key, BODY_FIELDS)?;
            fill(&mut map, &mut blobs, "blobs")?;
        }
        let blobs = blobs.ok_or_else(|| de::Error::missing_field("blobs"))?;
        Ok(SyncPushOpaqueBody {
            blobs: blobs.into_iter().map(|StrictBlob(blob)| blob).collect(),
        })
    }
}

struct BlobVisitor;

impl<'de> Visitor<'de> for BlobVisitor {
    type Value = StrictBlob;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("an opaque sync blob")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let (mut id, mut epoch, mut ciphertext) = (None, None, None);
        while let Some(key) = map.next_key::<String>()? {
            match field::<A::Error>(&key, BLOB_FIELDS)? {
                0 => fill(&mut map, &mut id, "id")?,
                1 => fill(&mut map, &mut epoch, "epoch")?,
                _ => fill(&mut map, &mut ciphertext, "ciphertext")?,
            }
        }
        Ok(StrictBlob(OpaqueSyncBlobDto {
            id: id.ok_or_else(|| de::Error::missing_field("id"))?,
            epoch: epoch.ok_or_else(|| de::Error::missing_field("epoch"))?,
            ciphertext: ciphertext.ok_or_else(|| de::Error::missing_field("ciphertext"))?,
        }))
    }
}

impl<'de> Deserialize<'de> for SyncPushOpaqueBody {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_struct("SyncPushOpaqueBody", BODY_FIELDS, BodyVisitor)
    }
}

impl<'de> Deserialize<'de> for StrictBlob {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_struct("OpaqueSyncBlobDto", BLOB_FIELDS, BlobVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(body: &str) -> Result<SyncPushOpaqueBody, String> {
        serde_json::from_str::<SyncPushOpaqueBody>(body).map_err(|error| error.to_string())
    }

    #[test]
    fn the_opaque_shape_decodes() {
        let body =
            decode(r#"{"blobs":[{"id":"a","epoch":1,"ciphertext":[1,2]}]}"#).expect("opaque push");
        assert_eq!(
            body.blobs,
            vec![OpaqueSyncBlobDto {
                id: "a".into(),
                epoch: 1,
                ciphertext: vec![1, 2],
            }]
        );
        assert!(decode(r#"{"blobs":[]}"#)
            .expect("empty push")
            .blobs
            .is_empty());
    }

    #[test]
    fn a_smuggled_field_is_refused_as_such_at_either_level() {
        for body in [
            r#"{"plaintext":"nope","blobs":[]}"#,
            r#"{"deployment_seal":"x"}"#,
            r#"{"blobs":[{"id":"a","epoch":1,"ciphertext":[1],"password":"x"}]}"#,
            r#"{"blobs":[{"vault_key":"k","id":"a","epoch":1,"ciphertext":[1]}]}"#,
        ] {
            let error = decode(body).expect_err(body);
            assert!(error.contains(PLAINTEXT_FORBIDDEN), "{body}: {error}");
        }
    }

    #[test]
    fn any_other_extra_field_or_shape_is_refused() {
        for body in [
            r#"{"blobs":[],"meta":{}}"#,
            r#"{"blobs":[{"id":"a","epoch":1,"ciphertext":[1],"note":"x"}]}"#,
            r#"{"blobs":[{"id":"a","epoch":1}]}"#,
            r#"{"blobs":[{"id":"a","epoch":-1,"ciphertext":[1]}]}"#,
            r#"{"blobs":[{"id":"a","epoch":1,"ciphertext":[256]}]}"#,
            r#"{"blobs":[],"blobs":[]}"#,
            r#"{"blobs":{}}"#,
            r#"[]"#,
            r#"{}"#,
        ] {
            let error = decode(body).expect_err(body);
            assert!(!error.contains(PLAINTEXT_FORBIDDEN), "{body}: {error}");
        }
    }

    async fn extracted(
        body: &'static str,
    ) -> Result<SyncPushOpaqueBody, (StatusCode, &'static str)> {
        use axum::extract::FromRequest;
        let request = axum::http::Request::builder()
            .method("POST")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(body))
            .expect("request");
        opaque_push_body(Json::<SyncPushOpaqueBody>::from_request(request, &()).await)
    }

    #[tokio::test]
    async fn rejections_map_to_closed_codes() {
        assert_eq!(
            extracted(r#"{"plaintext":"x"}"#)
                .await
                .expect_err("smuggled"),
            (StatusCode::BAD_REQUEST, PLAINTEXT_FORBIDDEN)
        );
        assert_eq!(
            extracted(r#"{"other":"x"}"#).await.expect_err("unknown"),
            (StatusCode::BAD_REQUEST, "invalid_sync_blobs")
        );
        assert_eq!(
            extracted("{").await.expect_err("syntax"),
            (StatusCode::BAD_REQUEST, "invalid_sync_blobs")
        );
        assert!(extracted(r#"{"blobs":[]}"#).await.is_ok());
    }
}
