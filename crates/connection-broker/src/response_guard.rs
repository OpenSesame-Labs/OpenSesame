//! Bounded reads for provider-controlled HTTP response bodies.
//!
//! Credentialed adapters map these errors to fixed, non-provider-controlled
//! diagnostics. No `reqwest::Error` text or response bytes cross this seam.

use bytes::Bytes;
use opensesame_invoke_through::scrub_credential_reflections;

use crate::error::BrokerError;

#[derive(Clone, Copy, Debug, thiserror::Error)]
pub(crate) enum ResponseBodyError {
    #[error("upstream response exceeds the {cap} byte limit")]
    TooLarge { cap: usize },
    #[error("could not read upstream response")]
    Read,
}

/// Read at most `cap` bytes, checking a declared length before accumulating
/// chunks and checking each chunk before extending the buffer.
pub(crate) async fn read_bounded_body(
    response: &mut reqwest::Response,
    cap: usize,
) -> Result<Bytes, ResponseBodyError> {
    if response
        .content_length()
        .is_some_and(|length| length > cap as u64)
    {
        return Err(ResponseBodyError::TooLarge { cap });
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ResponseBodyError::Read)?
    {
        if chunk.len() > cap.saturating_sub(body.len()) {
            return Err(ResponseBodyError::TooLarge { cap });
        }
        body.extend_from_slice(&chunk);
    }
    Ok(Bytes::from(body))
}

/// Only the RFC 6749 error code is quotable; all other fields remain opaque.
pub(crate) fn oauth_error_detail(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let code = value.get("error").and_then(|value| value.as_str())?;
    (code.len() <= 64
        && code
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "_.-".contains(character)))
    .then(|| code.to_string())
}

pub(crate) fn safe_oauth_error_detail(
    body: Bytes,
    submitted: &[&str],
) -> crate::error::Result<Option<String>> {
    let (body, reflected) = scrub_credential_reflections(body, submitted);
    if reflected {
        return Ok(None);
    }
    let body = String::from_utf8(body.to_vec())
        .map_err(|_| BrokerError::ExchangeFailed("token response was not valid UTF-8".into()))?;
    Ok(oauth_error_detail(&body))
}

/// `reqwest::Error` may contain a credentialed URL; retain only its class.
pub(crate) fn transport_detail(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "provider timed out".into()
    } else if error.is_connect() {
        "provider unreachable".into()
    } else {
        "provider request failed".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_error_text_contains_no_provider_bytes() {
        assert_eq!(
            ResponseBodyError::TooLarge { cap: 1024 }.to_string(),
            "upstream response exceeds the 1024 byte limit"
        );
        assert_eq!(
            ResponseBodyError::Read.to_string(),
            "could not read upstream response"
        );
    }

    #[test]
    fn oauth_error_code_cannot_reflect_submitted_material() {
        assert_eq!(
            safe_oauth_error_detail(
                Bytes::from_static(br#"{"error":"authorization-code-secret"}"#),
                &["authorization-code-secret", "client-secret"],
            )
            .unwrap(),
            None
        );
    }
}
