//! A GitHub delivery, admitted: MAC verified before a byte of it is decoded.
//!
//! The webhook used to take the body as `Bytes`, verify it, and then decode
//! the whole payload into an untyped `serde_json::Value` to read two fields.
//! Here the order is the rule — signature shape, secret, constant-time MAC,
//! delivery id — and only a verified body is decoded, into the two fields the
//! Host reads ([`DeliverySummary`]). Everything else GitHub sent is skipped
//! by the decoder rather than built into a document.

use axum::{
    body::Bytes,
    extract::{FromRequest, Request},
    http::{HeaderMap, StatusCode},
    response::Response,
};
use opensesame_connection_broker::github_webhook_hmac::verify_hub_signature_256;
use opensesame_host_core::bounded_json::{decode, read_bounded, BodyRejection};
use serde::Deserialize;

use super::{configured_webhook_secret, webhook_error, well_formed_hub_signature};
use crate::app_state::AppState;

/// The most of a delivery the Host reads: the router's default body limit,
/// which this route has always had.
pub(crate) const MAX_DELIVERY_BYTES: usize = 2 * 1024 * 1024;

/// What the Host reads from a delivery. Absent, or not this shape, is the
/// same as `{}`: no action, no installation.
#[derive(Debug, Default, Deserialize, PartialEq, Eq)]
pub(crate) struct DeliverySummary {
    #[serde(default)]
    pub(crate) action: Option<String>,
    #[serde(default)]
    installation: Option<InstallationRef>,
}

#[derive(Debug, Default, Deserialize, PartialEq, Eq)]
struct InstallationRef {
    #[serde(default)]
    id: Option<u64>,
}

impl DeliverySummary {
    /// Decode a verified body; anything that is not this shape is `{}`.
    pub(crate) fn of(body: &[u8]) -> Self {
        decode(body).unwrap_or_default()
    }

    /// The installation the delivery names, as the decimal string stored.
    pub(crate) fn installation_id(&self) -> Option<String> {
        self.installation
            .as_ref()
            .and_then(|installation| installation.id)
            .map(|id| id.to_string())
    }
}

/// A delivery whose `X-Hub-Signature-256` verified over its exact bytes.
pub(crate) struct VerifiedDelivery {
    pub(crate) delivery: String,
    pub(crate) event_name: String,
    pub(crate) body: Bytes,
    pub(crate) summary: DeliverySummary,
}

fn header(headers: &HeaderMap, name: &str) -> String {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string()
}

impl FromRequest<AppState> for VerifiedDelivery {
    type Rejection = Response;

    async fn from_request(req: Request, st: &AppState) -> Result<Self, Response> {
        let signature = header(req.headers(), "x-hub-signature-256");
        // Fail closed on a missing/malformed MAC before any DB or secret lookup.
        if !well_formed_hub_signature(&signature) {
            return Err(webhook_error(StatusCode::UNAUTHORIZED, "invalid_signature"));
        }
        let delivery = header(req.headers(), "x-github-delivery");
        let event_name = header(req.headers(), "x-github-event");
        let body =
            read_bounded(req, MAX_DELIVERY_BYTES)
                .await
                .map_err(|refused| match refused {
                    BodyRejection::TooLarge => {
                        webhook_error(StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large")
                    }
                    _ => webhook_error(StatusCode::BAD_REQUEST, "unreadable_body"),
                })?;
        let secret = configured_webhook_secret(st).await?;
        if !verify_hub_signature_256(&secret, &body, &signature) {
            return Err(webhook_error(StatusCode::UNAUTHORIZED, "invalid_signature"));
        }
        if delivery.is_empty() {
            return Err(webhook_error(
                StatusCode::BAD_REQUEST,
                "missing_delivery_id",
            ));
        }
        let summary = DeliverySummary::of(&body);
        Ok(Self {
            delivery,
            event_name,
            body,
            summary,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::DeliverySummary;

    #[test]
    fn reads_action_and_installation_and_skips_the_rest() {
        let summary = DeliverySummary::of(
            br#"{"action":"created","installation":{"id":42,"account":{"login":"o"}},
                "repositories":[{"id":1,"name":"r"}],"sender":{"login":"u"}}"#,
        );
        assert_eq!(summary.action.as_deref(), Some("created"));
        assert_eq!(summary.installation_id().as_deref(), Some("42"));
    }

    #[test]
    fn anything_else_reads_as_empty() {
        for body in [
            &b""[..],
            b"not json",
            b"[]",
            b"{\"action\":7}",
            b"{\"installation\":{\"id\":-1}}",
            b"{\"action\":\"x\"} trailing",
        ] {
            assert_eq!(DeliverySummary::of(body), DeliverySummary::default());
        }
        let ping = DeliverySummary::of(br#"{"zen":"Keep it simple.","hook_id":1}"#);
        assert_eq!(ping, DeliverySummary::default());
    }
}
