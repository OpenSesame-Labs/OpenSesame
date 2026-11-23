use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_domain::{InvocationReceipt, ReceiptId};
use serde_json::{json, Value};

use crate::app_state::AppState;
use crate::middleware::auth::resolve_caller;

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response()
}

/// Loads a receipt the caller is allowed to see. Unowned ids answer 404 so the
/// endpoint is not an existence oracle for other principals' receipts.
async fn load_owned(
    st: &AppState,
    headers: &axum::http::HeaderMap,
    id: &str,
) -> Result<InvocationReceipt, Response> {
    let caller = resolve_caller(st, headers)?;
    let Ok(rid) = ReceiptId::parse(id) else {
        return Err((StatusCode::BAD_REQUEST, Json(json!({"error":"invalid id"}))).into_response());
    };
    match st.db.get_receipt(&rid).await {
        // The store resolves the authoritative organization through the
        // invocation intent, including for legacy signed receipts that did not
        // carry an organization claim themselves.
        Ok(Some(stored))
            if caller.owns(&stored.receipt.principal_id)
                && caller.in_organization(&stored.organization_id) =>
        {
            Ok(stored.receipt)
        }
        Ok(_) => Err(not_found()),
        Err(e) => {
            let msg = opensesame_redaction::redact_text(&e.to_string());
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": msg})),
            )
                .into_response())
        }
    }
}

pub async fn get(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    match load_owned(&st, &headers, &id).await {
        Ok(r)
            if r.has_opaque_result()
                && r.has_confidential_idempotency_binding()
                && st.receipt_verifier.verify(&r).is_ok() =>
        {
            (StatusCode::OK, Json(r)).into_response()
        }
        Ok(_) => (
            StatusCode::CONFLICT,
            Json(json!({"error":"receipt_not_safely_disclosable"})),
        )
            .into_response(),
        Err(resp) => resp,
    }
}

/// Attach a private opening only to the authenticated invocation response.
/// Receipt GET never returns this value. The receipt signature stays over the
/// original receipt fields; the caller checks the opening against that receipt.
pub(super) fn private_receipt_body<T: serde::Serialize>(
    st: &AppState,
    receipt: &InvocationReceipt,
    digest: &str,
    intent: &T,
) -> Result<Value, Response> {
    let unavailable = || {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"receipt_opening_unavailable"})),
        )
            .into_response()
    };
    let opening = st
        .broker
        .signer
        .open_receipt_intent(receipt)
        .map_err(|_| unavailable())?;
    if !receipt.verifies_intent_opening(&opening, digest) {
        return Err(unavailable());
    }
    let mut body = serde_json::to_value(receipt).map_err(|_| unavailable())?;
    let intent = serde_json::to_value(intent).map_err(|_| unavailable())?;
    let object = body.as_object_mut().ok_or_else(unavailable)?;
    object.insert(
        "intent_opening".into(),
        json!({"opening": opening, "intent_digest": digest, "intent": intent}),
    );
    Ok(body)
}

pub(super) fn private_response(status: StatusCode, body: Value) -> Response {
    let mut response = (status, Json(body)).into_response();
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}

/// Public keys that may have signed a receipt.
///
/// Receipts are evidence, and evidence nobody else can check is not evidence:
/// publishing the public halves lets a holder verify a receipt without the
/// gateway's word for it. Nothing secret is exposed.
pub async fn keys(State(st): State<AppState>) -> Response {
    let keys: Vec<_> = st
        .receipt_verifier
        .published_keys()
        .into_iter()
        .map(|(key_id, public_key)| {
            json!({"key_id": key_id, "algorithm": "ed25519", "public_key_b64": public_key})
        })
        .collect();
    (StatusCode::OK, Json(json!({"keys": keys}))).into_response()
}

pub async fn verify(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let receipt = match load_owned(&st, &headers, &id).await {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    match st.receipt_verifier.verify(&receipt) {
        Ok(()) => (StatusCode::OK, Json(json!({"valid": true}))).into_response(),
        Err(e) => {
            let msg = opensesame_redaction::redact_text(&e.to_string());
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"valid": false, "error": msg})),
            )
                .into_response()
        }
    }
}

#[cfg(test)]
#[path = "receipts_tests.rs"]
mod tests;
