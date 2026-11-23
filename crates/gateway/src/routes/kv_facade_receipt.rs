//! Signed evidence for KV facade reads.

use super::*;
use crate::middleware::auth::parse_principal;
use opensesame_domain::{
    ActorId, ConnectionId, DetachedProof, Intent, IntentId, Invocation, InvocationId,
    InvocationState, PrincipalId, ReceiptOutcome,
};
use opensesame_time::Duration;

// ---- receipts --------------------------------------------------------------

/// Signs and persists the receipt for one read, through the same storage and
/// the same signer `opensesame_broker::Broker` uses.
///
/// Fails closed: when the receipt cannot be recorded — most commonly because
/// the caller's organization has no row for the intent to reference — the read
/// is refused rather than served without evidence.
pub(super) async fn emit_receipt(
    st: &AppState,
    caller: &Caller,
    organization_id: &OrganizationId,
    operation: &str,
    resource: &str,
    view: &ConnectionView,
) -> Result<ReceiptId, Response> {
    let boot = st.bootstrap.lock().unwrap().clone();
    let principal_id = match caller {
        Caller::Session { subject, .. } => parse_principal(subject)
            .or_else(|| boot.as_ref().map(|b| b.principal))
            .unwrap_or_else(|| PrincipalId::from_uuid(uuid::Uuid::nil())),
        Caller::Operator => boot.as_ref().map_or_else(
            || PrincipalId::from_uuid(uuid::Uuid::nil()),
            |b| b.principal,
        ),
    };
    let actor_id = boot
        .as_ref()
        .map_or_else(|| ActorId::from_uuid(uuid::Uuid::nil()), |b| b.actor);
    let now = Utc::now();
    let intent = Intent {
        id: IntentId::new(),
        organization_id: *organization_id,
        project_id: None,
        principal_id,
        actor_id,
        actor_instance_id: None,
        client_id: None,
        operator_id: None,
        connection_id: ConnectionId::parse(&view.connection_id).ok(),
        operation: operation.to_string(),
        resource: resource.to_string(),
        audience: format!("kv-v2-facade://{KV_MOUNT}"),
        normalized_parameters_hash: Intent::parameters_hash(&json!({}))
            .map_err(|_| receipt_unavailable())?,
        body_hash: None,
        nonce: uuid::Uuid::new_v4().to_string(),
        idempotency_key: uuid::Uuid::new_v4().to_string(),
        issued_at: now,
        expires_at: now + Duration::minutes(5),
        parent_invocation_id: None,
        delegation_chain: boot.as_ref().map(|b| vec![b.grant.id]).unwrap_or_default(),
        // There is no client proof on this path, and claiming one would be a
        // lie a verifier could not detect. The receipt records that honestly.
        proof: DetachedProof {
            algorithm: "none".into(),
            key_thumbprint: "kv-v2-facade".into(),
            signature: String::new(),
        },
    };
    let invocation = Invocation {
        id: InvocationId::new(),
        intent_id: intent.id,
        state: InvocationState::Succeeded,
        attempt: 1,
        lease_owner: None,
        lease_expires_at: None,
        created_at: now,
        updated_at: Utc::now(),
    };
    let digest = intent.digest().map_err(|_| receipt_unavailable())?;
    let receipt = opensesame_domain::InvocationReceipt {
        id: ReceiptId::new(),
        invocation_id: invocation.id,
        intent_digest: st
            .broker
            .signer
            .intent_commitment(&invocation.id, &digest)
            .map_err(|_| receipt_unavailable())?,
        idempotency_binding: None,
        principal_id,
        organization_id: Some(*organization_id),
        actor_id,
        actor_instance_id: None,
        client_id: None,
        operator_id: None,
        delegation_chain: intent.delegation_chain.clone(),
        connection_id: intent.connection_id,
        operation: intent.operation.clone(),
        resource: intent.resource.clone(),
        policy_decision_id: "kv-facade-read-only".into(),
        policy_version_digest: "kv-facade/1".into(),
        approval_id: None,
        credential_handle_id: None,
        connector_component_digest: None,
        external_request_digest: None,
        external_response_digest: None,
        started_at: now,
        completed_at: Utc::now(),
        outcome: ReceiptOutcome::Succeeded,
        safe_result_summary: None,
        authority_key_id: String::new(),
        signature: String::new(),
        receipt_schema_version: opensesame_domain::OPAQUE_RESULT_RECEIPT_SCHEMA_VERSION,
        task_run_id: None,
        task_state_version: None,
        task_state_digest: None,
    };
    let receipt = st
        .broker
        .signer
        .sign_receipt(receipt)
        .map_err(|_| receipt_unavailable())?;
    if !receipt.assert_no_secret_leak() {
        tracing::error!("kv facade receipt summary rejected by the secret-leak check");
        return Err(receipt_unavailable());
    }
    let id = receipt.id;
    persist_read_receipt(st, intent, invocation, receipt).await?;
    Ok(id)
}

async fn persist_read_receipt(
    st: &AppState,
    intent: Intent,
    invocation: Invocation,
    receipt: opensesame_domain::InvocationReceipt,
) -> Result<(), Response> {
    st.db
        .insert_intent(&intent)
        .await
        .map_err(|error| receipt_storage_failure(&error))?;
    st.db
        .insert_invocation(&invocation)
        .await
        .map_err(|error| receipt_storage_failure(&error))?;
    st.db
        .insert_receipt(&receipt)
        .await
        .map_err(|error| receipt_storage_failure(&error))?;
    Ok(())
}

fn receipt_storage_failure(error: &anyhow::Error) -> Response {
    // Storage errors can echo identifiers; redact before they reach a log.
    tracing::error!(
        error = %opensesame_redaction::redact_text(&error.to_string()),
        "kv facade could not record a read receipt; refusing the read"
    );
    receipt_unavailable()
}

fn receipt_unavailable() -> Response {
    vault_error(
        StatusCode::SERVICE_UNAVAILABLE,
        &["read refused: the receipt for this read could not be recorded"],
    )
}

#[cfg(test)]
#[path = "kv_facade/opening_tests.rs"]
mod opening_tests;
