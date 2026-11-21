//! Private recovery of an opening for an already-settled task invocation.

use axum::{
    body::to_bytes,
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use opensesame_broker::FrozenInvokeInput;
use opensesame_domain::{Capability, FrozenIntentV2, ResourceSelector};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    app_state::AppState,
    middleware::auth::{resolve_caller, resolve_caller_subject},
};

// Normalization can expand numeric JSON; freeze admission verifies the exact
// saved recovery envelope against this bound before storing the frozen intent.
pub(super) const MAX_RECOVERY_BODY_BYTES: usize = 16 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecoverOpening {
    intent: FrozenIntentV2,
    intent_digest: String,
}

fn unavailable() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response()
}

/// Authentication happens before parsing or looking up candidate intents.
/// All authorized missing, mismatched and unavailable cases look alike.
pub async fn recover(State(st): State<AppState>, headers: HeaderMap, request: Request) -> Response {
    let caller = match resolve_caller(&st, &headers) {
        Ok(caller) => caller,
        Err(response) => return response,
    };
    let subject = match resolve_caller_subject(&st, &headers) {
        Ok(subject) => subject,
        Err(response) => return response,
    };
    let bytes = match tokio::time::timeout(
        std::time::Duration::from_secs(5),
        to_bytes(request.into_body(), MAX_RECOVERY_BODY_BYTES),
    )
    .await
    {
        Ok(Ok(bytes)) => bytes,
        _ => return unavailable(),
    };
    let wire: Value = match serde_json::from_slice(&bytes) {
        Ok(wire) => wire,
        Err(_) => return unavailable(),
    };
    let request: RecoverOpening = match serde_json::from_value(wire.clone()) {
        Ok(request) => request,
        Err(_) => return unavailable(),
    };
    let intent = match request.intent.with_computed_digest() {
        Ok(intent) if intent.intent_digest == request.intent_digest => intent,
        _ => return unavailable(),
    };
    let mut canonical = match serde_json::to_value(&intent) {
        Ok(value) => value,
        Err(_) => return unavailable(),
    };
    let Some(object) = canonical.as_object_mut() else {
        return unavailable();
    };
    object.remove("intent_digest");
    if wire.get("intent") != Some(&canonical) {
        return unavailable();
    }
    if !caller.owns(&intent.principal_id) || !caller.in_organization(&intent.organization_id) {
        return unavailable();
    }
    let boot = match super::tasks::active_execution_bootstrap_for_organization(
        &st,
        &intent.organization_id,
        &intent.principal_id,
    )
    .await
    {
        Ok(boot) => boot,
        Err(_) => return unavailable(),
    };
    let required = Capability::new(
        intent.operation.clone(),
        ResourceSelector::exact(intent.resource.clone()),
    );
    let connection_policy_id =
        match super::intents_bootstrap::bootstrap_connection_policy_for(&st, &boot) {
            Ok(id) => id,
            Err(response) => return response,
        };
    let receipt = match st
        .broker
        .recover_frozen_receipt(FrozenInvokeInput {
            intent,
            grant: boot.grant,
            subject,
            connection_policy_id,
            required_capability: required,
            lineage: None,
        })
        .await
    {
        Ok(receipt) => receipt,
        Err(_) => return unavailable(),
    };
    let opening = match st.broker.signer.open_receipt_intent(&receipt) {
        Ok(opening) => opening,
        Err(_) => return unavailable(),
    };
    super::receipts::private_response(StatusCode::OK, json!({"opening": opening}))
}
