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
#[path = "bounded_json_tests.rs"]
mod tests;
