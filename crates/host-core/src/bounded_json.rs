//! One bounded, typed decode for a JSON request body.
//!
//! A route that read its body as `String` or `Bytes` and handed it to
//! `serde_json` itself buffered whatever the router's default limit allowed
//! (2 MiB) before its own size check ran, and every route repeated that check,
//! the empty-body rule and the parse. [`BoundedJson`] is the one place a JSON
//! body becomes a value:
//!
//! 1. the read stops at `LIMIT` bytes: a body that is longer is refused
//!    without being buffered past the limit, and a `Content-Length` over it is
//!    refused before any byte is read;
//! 2. an empty (or all-whitespace) body is its own refusal, so a route that
//!    treats it as `{}` says so ([`BodyRejection::Empty`]) and one that does
//!    not refuses it;
//! 3. the body is decoded straight into the route's typed `T` — never into an
//!    untyped `serde_json::Value` first — and `T` is where a route declares
//!    `#[serde(deny_unknown_fields)]` and its bounded field types.
//!
//! A handler takes `Result<BoundedJson<T, LIMIT>, BodyRejection>` when it must
//! decide (after authenticating the caller, say) how a refusal is answered, or
//! `BoundedJson<T, LIMIT>` to answer with [`BodyRejection`]'s own house shape.

use axum::{
    body::Bytes,
    extract::{FromRequest, Request},
    http::{header::CONTENT_LENGTH, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::de::DeserializeOwned;
use serde_json::json;

/// The limit a route gets unless it names its own: 32 KiB, the size the
/// connection routes have always enforced.
pub const DEFAULT_LIMIT: usize = 32 * 1024;

/// A JSON body of at most `LIMIT` bytes, decoded into `T`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundedJson<T, const LIMIT: usize = DEFAULT_LIMIT>(pub T);

/// A JSON body of at most `LIMIT` bytes, decoded into `T`, with the exact
/// bytes it was decoded from — for a route that authenticates those bytes
/// (a signature, a digest) as well as reading them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundedJsonWithRaw<T, const LIMIT: usize = DEFAULT_LIMIT> {
    /// The decoded body.
    pub value: T,
    /// The bytes it was decoded from, exactly as received.
    pub raw: Bytes,
}

/// Why a body did not become a value. It never carries the body's content.
#[derive(Debug)]
pub enum BodyRejection {
    /// Longer than the route's limit; the read stopped at the limit.
    TooLarge,
    /// The connection failed before the body ended.
    Unreadable,
    /// No body, or only whitespace.
    Empty,
    /// Not JSON, or not the route's `T` (an unknown field, a wrong type, a
    /// missing field, trailing data). The error says where, not what: its
    /// display may quote a rejected value, so a route that echoes errors
    /// should answer with a fixed sentence instead.
    Malformed(serde_json::Error),
}

impl BodyRejection {
    /// The closed code for this refusal.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::TooLarge => "payload_too_large",
            Self::Unreadable | Self::Empty | Self::Malformed(_) => "invalid_request",
        }
    }

    /// The status this refusal is answered with.
    #[must_use]
    pub const fn status(&self) -> StatusCode {
        match self {
            Self::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::Unreadable | Self::Empty | Self::Malformed(_) => StatusCode::BAD_REQUEST,
        }
    }
}

impl std::fmt::Display for BodyRejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::TooLarge => "request body exceeds the limit for this route",
            Self::Unreadable => "request body could not be read",
            Self::Empty => "request body is empty",
            Self::Malformed(_) => "request body is not valid JSON for this route",
        })
    }
}

impl std::error::Error for BodyRejection {}

impl IntoResponse for BodyRejection {
    fn into_response(self) -> Response {
        (
            self.status(),
            Json(json!({"error": self.code(), "hint": self.to_string()})),
        )
            .into_response()
    }
}

impl<S, T, const LIMIT: usize> FromRequest<S> for BoundedJson<T, LIMIT>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = BodyRejection;

    async fn from_request(req: Request, _state: &S) -> Result<Self, Self::Rejection> {
        let raw = read_bounded(req, LIMIT).await?;
        decode(&raw).map(Self)
    }
}

impl<S, T, const LIMIT: usize> FromRequest<S> for BoundedJsonWithRaw<T, LIMIT>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = BodyRejection;

    async fn from_request(req: Request, _state: &S) -> Result<Self, Self::Rejection> {
        let raw = read_bounded(req, LIMIT).await?;
        let value = decode(&raw)?;
        Ok(Self { value, raw })
    }
}

/// Read at most `limit` bytes of `req`'s body.
///
/// For an extractor that must do something with the bytes (verify a MAC)
/// before it decodes them with [`decode`].
///
/// # Errors
///
/// [`BodyRejection::TooLarge`] when the declared or actual length exceeds
/// `limit`, [`BodyRejection::Unreadable`] when the body stream fails.
pub async fn read_bounded(req: Request, limit: usize) -> Result<Bytes, BodyRejection> {
    let declared = req
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if declared.is_some_and(|length| length > limit as u64) {
        return Err(BodyRejection::TooLarge);
    }
    axum::body::to_bytes(req.into_body(), limit)
        .await
        .map_err(|error| {
            if exceeded_limit(&error) {
                BodyRejection::TooLarge
            } else {
                BodyRejection::Unreadable
            }
        })
}

/// Decode a body already read within its limit into `T`.
///
/// # Errors
///
/// [`BodyRejection::Empty`] for an empty or all-whitespace body,
/// [`BodyRejection::Malformed`] when it is not a `T`.
pub fn decode<T: DeserializeOwned>(raw: &[u8]) -> Result<T, BodyRejection> {
    if raw.iter().all(u8::is_ascii_whitespace) {
        return Err(BodyRejection::Empty);
    }
    serde_json::from_slice(raw).map_err(BodyRejection::Malformed)
}

fn exceeded_limit(error: &axum::Error) -> bool {
    let mut cause: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(current) = cause {
        if current.is::<http_body_util::LengthLimitError>() {
            return true;
        }
        cause = current.source();
    }
    false
}

#[cfg(test)]
mod tests {
    use axum::{
        body::Body,
        extract::FromRequest,
        http::{header::CONTENT_LENGTH, Request, StatusCode},
        response::IntoResponse,
    };
    use serde::Deserialize;

    use super::{BodyRejection, BoundedJson, BoundedJsonWithRaw};

    #[derive(Debug, Deserialize, PartialEq, Eq)]
    #[serde(deny_unknown_fields)]
    struct Probe {
        name: String,
        #[serde(default)]
        count: u32,
    }

    fn request(body: impl Into<Body>) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri("/probe")
            .body(body.into())
            .expect("request")
    }

    async fn extract<const LIMIT: usize>(
        req: Request<Body>,
    ) -> Result<BoundedJson<Probe, LIMIT>, BodyRejection> {
        BoundedJson::<Probe, LIMIT>::from_request(req, &()).await
    }

    #[tokio::test]
    async fn a_valid_body_within_the_limit_decodes() {
        let decoded = extract::<64>(request(r#"{"name":"a","count":2}"#))
            .await
            .expect("valid body");
        assert_eq!(
            decoded.0,
            Probe {
                name: "a".into(),
                count: 2
            }
        );
    }

    #[tokio::test]
    async fn a_body_exactly_at_the_limit_decodes() {
        let body = r#"{"name":"abc"}"#;
        assert_eq!(body.len(), 14);
        assert!(extract::<14>(request(body)).await.is_ok());
    }

    #[tokio::test]
    async fn an_oversized_body_is_refused_without_a_content_length() {
        let body = format!(r#"{{"name":"{}"}}"#, "x".repeat(100));
        let refused = extract::<64>(request(body)).await.expect_err("too large");
        assert!(matches!(refused, BodyRejection::TooLarge));
        assert_eq!(
            refused.into_response().status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
    }

    #[tokio::test]
    async fn an_oversized_declared_length_is_refused_before_reading() {
        let req = Request::builder()
            .method("POST")
            .uri("/probe")
            .header(CONTENT_LENGTH, "1048576")
            .body(Body::from(r#"{"name":"a"}"#))
            .expect("request");
        let refused = extract::<64>(req).await.expect_err("declared too large");
        assert!(matches!(refused, BodyRejection::TooLarge));
    }

    #[tokio::test]
    async fn a_streamed_oversized_body_is_refused() {
        let chunks: Vec<Result<&'static [u8], std::io::Error>> =
            vec![Ok(br#"{"name":""#), Ok(&[b'x'; 80]), Ok(br#""}"#)];
        let body = Body::from_stream(futures::stream::iter(chunks));
        let refused = extract::<64>(request(body))
            .await
            .expect_err("streamed too large");
        assert!(matches!(refused, BodyRejection::TooLarge));
    }

    #[tokio::test]
    async fn an_unknown_field_is_refused() {
        let refused = extract::<64>(request(r#"{"name":"a","admin":true}"#))
            .await
            .expect_err("unknown field");
        assert!(matches!(refused, BodyRejection::Malformed(_)));
        assert_eq!(refused.into_response().status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn malformed_json_and_wrong_types_are_refused() {
        for body in [
            "{",
            "not json",
            r#"{"name":1}"#,
            r#"{"count":1}"#,
            r#"{"name":"a"} trailing"#,
            r#"{"name":"a","count":-1}"#,
        ] {
            let refused = extract::<64>(request(body)).await.expect_err(body);
            assert!(matches!(refused, BodyRejection::Malformed(_)), "{body}");
        }
    }

    #[tokio::test]
    async fn an_empty_or_blank_body_is_its_own_refusal() {
        for body in ["", "   \n\t"] {
            let refused = extract::<64>(request(body)).await.expect_err("empty");
            assert!(matches!(refused, BodyRejection::Empty), "{body:?}");
        }
    }

    #[tokio::test]
    async fn deep_nesting_is_refused_not_overflowed() {
        let body = format!("{}{}", "[".repeat(4096), "]".repeat(4096));
        let refused = BoundedJson::<serde_json::Value, 16_384>::from_request(request(body), &())
            .await
            .expect_err("recursion limit");
        assert!(matches!(refused, BodyRejection::Malformed(_)));
    }

    #[tokio::test]
    async fn with_raw_keeps_the_exact_bytes() {
        let body = r#"{ "name" : "a" }"#;
        let decoded = BoundedJsonWithRaw::<Probe, 64>::from_request(request(body), &())
            .await
            .expect("valid body");
        assert_eq!(decoded.raw.as_ref(), body.as_bytes());
        assert_eq!(decoded.value.name, "a");
    }

    #[test]
    fn refusals_never_echo_the_body() {
        let error = serde_json::from_str::<Probe>(r#"{"name":"hunter2-secret","x":1}"#)
            .expect_err("unknown field");
        let refusal = BodyRejection::Malformed(error);
        assert!(!refusal.to_string().contains("hunter2"));
    }
}
