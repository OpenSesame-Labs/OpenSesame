use super::*;
use opensesame_broker::InvokeInput;
use opensesame_domain::*;
use opensesame_time::{Duration, Utc};
use serde_json::json;

async fn state_with_receipt() -> (AppState, InvocationReceipt, String, OrganizationId) {
    let state = crate::app_state::test_demo_state().await;
    let boot = state.bootstrap.lock().unwrap().clone().unwrap();
    let parameters = json!({});
    let now = Utc::now();
    let receipt = state
        .broker
        .invoke(InvokeInput {
            intent: Intent {
                id: IntentId::new(),
                organization_id: boot.org,
                project_id: Some(boot.project),
                principal_id: boot.principal,
                actor_id: boot.actor,
                actor_instance_id: None,
                client_id: None,
                operator_id: None,
                connection_id: Some(boot.connection),
                operation: "repository.read".into(),
                resource: "repo:acme/catalog".into(),
                audience: "https://api.github.com".into(),
                normalized_parameters_hash: Intent::parameters_hash(&parameters).unwrap(),
                body_hash: None,
                nonce: uuid::Uuid::new_v4().to_string(),
                idempotency_key: uuid::Uuid::new_v4().to_string(),
                issued_at: now,
                expires_at: now + Duration::minutes(5),
                parent_invocation_id: None,
                delegation_chain: vec![boot.grant.id],
                proof: DetachedProof {
                    algorithm: "EdDSA".into(),
                    key_thumbprint: "test".into(),
                    signature: "test".into(),
                },
            },
            grant: boot.grant.clone(),
            subject: "user:demo".into(),
            connection_policy_id: "demo-conn".into(),
            parameters,
            lineage: None,
        })
        .await
        .unwrap();
    (
        state,
        receipt,
        format!("prn_{}", boot.principal.as_uuid()),
        boot.org,
    )
}

#[tokio::test]
async fn same_principal_cannot_get_or_verify_another_organizations_receipt() {
    let (state, receipt, subject, _) = state_with_receipt().await;
    let headers = crate::app_state::test_session_headers(
        &state,
        &subject,
        OrganizationId::new(),
        OrganizationRole::Member,
    );

    let get_response = get(
        State(state.clone()),
        headers.clone(),
        Path(receipt.id.to_string()),
    )
    .await;
    assert_eq!(get_response.status(), StatusCode::NOT_FOUND);
    let verify_response = verify(State(state), headers, Path(receipt.id.to_string())).await;
    assert_eq!(verify_response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn matching_organization_and_operator_can_read_receipt_evidence() {
    let (state, receipt, subject, organization_id) = state_with_receipt().await;
    let session_headers = crate::app_state::test_session_headers(
        &state,
        &subject,
        organization_id,
        OrganizationRole::Member,
    );
    let get_response = get(
        State(state.clone()),
        session_headers,
        Path(receipt.id.to_string()),
    )
    .await;
    assert_eq!(get_response.status(), StatusCode::OK);

    let mut operator_headers = axum::http::HeaderMap::new();
    operator_headers.insert(
        "x-opensesame-operator",
        state.operator_token.parse().unwrap(),
    );
    let verify_response =
        verify(State(state), operator_headers, Path(receipt.id.to_string())).await;
    assert_eq!(verify_response.status(), StatusCode::OK);
}

#[tokio::test]
async fn legacy_or_forged_receipts_are_withheld_but_legacy_signatures_verify() {
    let (state, receipt, subject, organization_id) = state_with_receipt().await;
    let headers = crate::app_state::test_session_headers(
        &state,
        &subject,
        organization_id,
        OrganizationRole::Member,
    );
    sqlx::query("DELETE FROM receipts WHERE id = ?")
        .bind(receipt.id.to_string())
        .execute(state.db.pool())
        .await
        .unwrap();
    let mut legacy = receipt;
    legacy.receipt_schema_version = 3;
    legacy.idempotency_binding = None;
    legacy.safe_result_summary = Some(json!({"result":"1-ssecca-ecar"}));
    let legacy = state.broker.signer.sign_receipt(legacy).unwrap();
    state.db.insert_receipt(&legacy).await.unwrap();
    let id = legacy.id.to_string();
    let response = get(State(state.clone()), headers.clone(), Path(id.clone())).await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let verified = verify(State(state.clone()), headers.clone(), Path(id.clone())).await;
    assert_eq!(verified.status(), StatusCode::OK);

    sqlx::query("DELETE FROM receipts WHERE id = ?")
        .bind(&id)
        .execute(state.db.pool())
        .await
        .unwrap();
    let mut forged = legacy;
    forged.receipt_schema_version = 6;
    forged.safe_result_summary = None;
    state.db.insert_receipt(&forged).await.unwrap();
    let response = get(State(state.clone()), headers, Path(id)).await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn signed_unkeyed_binding_is_not_disclosed_but_remains_verifiable() {
    let (state, receipt, subject, organization_id) = state_with_receipt().await;
    let headers = crate::app_state::test_session_headers(
        &state,
        &subject,
        organization_id,
        OrganizationRole::Member,
    );
    sqlx::query("DELETE FROM receipts WHERE id = ?")
        .bind(receipt.id.to_string())
        .execute(state.db.pool())
        .await
        .unwrap();
    let mut legacy = receipt;
    legacy.idempotency_binding = Some("sha256:guessable".into());
    let legacy = state.broker.signer.sign_receipt(legacy).unwrap();
    assert!(legacy.has_opaque_result());
    assert!(!legacy.has_confidential_idempotency_binding());
    let id = legacy.id.to_string();
    state.db.insert_receipt(&legacy).await.unwrap();
    assert_eq!(
        get(State(state.clone()), headers.clone(), Path(id.clone()))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        verify(State(state), headers, Path(id)).await.status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn legacy_raw_intent_digest_is_not_disclosed_but_its_signature_verifies() {
    let (state, receipt, subject, organization_id) = state_with_receipt().await;
    let headers = crate::app_state::test_session_headers(
        &state,
        &subject,
        organization_id,
        OrganizationRole::Member,
    );
    sqlx::query("DELETE FROM receipts WHERE id = ?")
        .bind(receipt.id.to_string())
        .execute(state.db.pool())
        .await
        .unwrap();
    let mut legacy = receipt;
    legacy.receipt_schema_version = 5;
    legacy.intent_digest = "sha256:guessable-intent".into();
    let legacy = state.broker.signer.sign_receipt(legacy).unwrap();
    let id = legacy.id.to_string();
    state.db.insert_receipt(&legacy).await.unwrap();
    assert_eq!(
        get(State(state.clone()), headers.clone(), Path(id.clone()))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        verify(State(state), headers, Path(id)).await.status(),
        StatusCode::OK
    );
}
