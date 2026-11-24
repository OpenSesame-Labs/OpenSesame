//! What a driver's outcome must be before it is stored (ADR 0159).
//!
//! The settle route used to persist whatever JSON the driver sent, and only
//! the executor, later and only if it was still waiting, decoded it. That left
//! a window in which a convenient extra field (`{"outcome":"done","password":
//! "x"}`) sat in the queue for the life of the run, and a driver could answer a
//! `navigate` with a screenshot. Both are refused here, at the one place a
//! driver's word becomes a row:
//!
//! 1. the pending request says which outcomes may answer it — a closed table
//!    from the request's `step` tag, the same one `ExtensionTransport` and
//!    `DriverCandidateVault` match against when they decode (`failed` answers
//!    anything);
//! 2. the outcome is decoded into the typed enum (`StepOutcome`, or the custody
//!    outcomes for the three custody steps), whose fields are the only places a
//!    value could ride;
//! 3. what is stored is the **canonical** encoding of what was decoded. A
//!    driver's JSON that differs from it — an unknown field at any depth, a
//!    non-canonical shape — is refused, not trimmed: a driver that adds a field
//!    is not one whose other fields are to be trusted.
//!
//! Refusals carry a closed code and say nothing the driver sent.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_rotation_web::StepOutcome;
use serde::{de::DeserializeOwned, Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};

use crate::web_login::custody::{CustodyOutcome, GENERATE_STEP, PROMOTE_STEP, SEAL_STEP};

/// Why an outcome is not one the pending step could have produced.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Refusal {
    /// The queued request names no step this route knows an outcome for.
    UnknownStep,
    /// A well-formed outcome, but not one that answers this step.
    WrongOutcome,
    /// Not decodable as the outcome the step expects, or it carries more than
    /// that outcome has fields for.
    Malformed,
}

impl Refusal {
    /// The stable error code on the wire.
    pub(super) const fn code(self) -> &'static str {
        match self {
            Self::UnknownStep => "unknown_step",
            Self::WrongOutcome => "wrong_outcome",
            Self::Malformed => "invalid_outcome",
        }
    }

    pub(super) fn response(self) -> Response {
        let (status, hint) = match self {
            Self::UnknownStep => (
                StatusCode::CONFLICT,
                "this step has no outcome the Host can accept",
            ),
            Self::WrongOutcome => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "that outcome does not answer this step",
            ),
            Self::Malformed => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "an outcome carries exactly its own fields and no others",
            ),
        };
        (status, Json(json!({"error": self.code(), "hint": hint}))).into_response()
    }
}

/// The outcome tags that may answer the step tagged `step`, besides `failed`.
fn answers(step: &str) -> Option<&'static str> {
    Some(match step {
        "navigate" | "wait_for" | "submit" | GENERATE_STEP | PROMOTE_STEP => "done",
        "fill_credential" => "filled",
        "assert_present" => "presence",
        "read_dom_redacted" => "dom",
        "screenshot_redacted" => "frame",
        "verify_login" => "verified",
        "capture_credential" | "capture_download" => "captured",
        SEAL_STEP => "sealed",
        _ => return None,
    })
}

fn is_custody(step: &str) -> bool {
    matches!(step, GENERATE_STEP | SEAL_STEP | PROMOTE_STEP)
}

/// A driver's outcome, decoded once where the settle body is decoded.
///
/// The untyped JSON never reaches the route: what is kept is its tag and, for
/// each of the two closed outcome sets, its canonical encoding — present only
/// when the driver's JSON *is* that encoding (an unknown field at any depth, a
/// non-canonical shape, or a missing field leaves it absent). Which set
/// applies is decided later, against the pending step.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct DriverOutcome {
    tag: Option<String>,
    step: Option<Value>,
    custody: Option<Value>,
}

impl DriverOutcome {
    pub(super) fn of(raw: &Value) -> Self {
        Self {
            tag: raw
                .get("outcome")
                .and_then(Value::as_str)
                .map(str::to_owned),
            step: canonical_as::<StepOutcome>(raw),
            custody: canonical_as::<CustodyOutcome>(raw),
        }
    }
}

impl<'de> Deserialize<'de> for DriverOutcome {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Value::deserialize(deserializer).map(|raw| Self::of(&raw))
    }
}

/// `raw` decoded as a `T` and re-encoded, when that is exactly `raw`.
fn canonical_as<T: DeserializeOwned + Serialize>(raw: &Value) -> Option<Value> {
    let typed = T::deserialize(raw).ok()?;
    let encoded = serde_json::to_value(typed).ok()?;
    // What is stored is what was decoded. Anything the driver added, anywhere,
    // is the difference.
    (encoded == *raw).then_some(encoded)
}

/// The canonical outcome for the step whose request is `request_json`.
///
/// # Errors
///
/// A [`Refusal`] when the outcome is not what that step may be answered with.
pub(super) fn canonical(request_json: &str, outcome: &DriverOutcome) -> Result<Value, Refusal> {
    let request: Value = serde_json::from_str(request_json).map_err(|_| Refusal::UnknownStep)?;
    let step = request["step"].as_str().ok_or(Refusal::UnknownStep)?;
    let expected = answers(step).ok_or(Refusal::UnknownStep)?;
    match outcome.tag.as_deref() {
        Some(tag) if tag == expected || tag == "failed" => {}
        Some(_) => return Err(Refusal::WrongOutcome),
        None => return Err(Refusal::Malformed),
    }
    let decoded = if is_custody(step) {
        &outcome.custody
    } else {
        &outcome.step
    };
    decoded.clone().ok_or(Refusal::Malformed)
}

#[cfg(test)]
#[path = "outcome_tests.rs"]
mod tests;
