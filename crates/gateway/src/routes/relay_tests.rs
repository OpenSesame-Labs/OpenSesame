use super::*;
use axum::extract::State;
use opensesame_connection_broker::delegation::{
    ClaimOfferRequest, MintOfferRequest, OfferItemSpec,
};
use opensesame_connection_broker::model::ConnectionStatus;
use opensesame_connection_broker::store as broker_store;
use opensesame_domain::{ConnectionId, EgressBinding, OrganizationId, OrganizationRole};

const OWNER: &str = "principal:00000000-0000-4000-8000-000000000015";
const GUEST: &str = "principal:00000000-0000-4000-8000-000000000016";

async fn relay_delegation(
    state: &crate::app_state::AppState,
    org: OrganizationId,
    mode: ExecutionMode,
) -> String {
    let now = Utc::now();
    let row = broker_store::ConnectionRow {
        id: ConnectionId::new().to_string(),
        organization_id: org.to_string(),
        project_id: None,
        provider_id: "github".into(),
        integration_id: "deployment:github".into(),
        logical_name: format!("github-{}", uuid::Uuid::now_v7().simple()),
        display_name: "Holder's GitHub".into(),
        status: ConnectionStatus::Active,
        status_detail: None,
        requested_scopes: vec![],
        granted_scopes: vec![],
        account_label: None,
        owner_kind: "user".into(),
        owner_subject: Some(OWNER.into()),
        shareability: "delegable".into(),
        max_invoke_level: 2,
        materialization: "deny".into(),
        egress: EgressBinding {
            scheme: "https".into(),
            authorities: vec!["api.github.com".into()],
            path_prefixes: vec![],
            allow_redirects_cross_authority: false,
        },
        created_at: now,
        updated_at: now,
    };
    broker_store::insert_connection(state.connection_broker.pool(), &row)
        .await
        .expect("insert connection");
    claim_relay_delegation(state, org, &row.id, mode).await
}

async fn claim_relay_delegation(
    state: &AppState,
    org: OrganizationId,
    connection_id: &str,
    mode: ExecutionMode,
) -> String {
    let minted = state
        .connection_broker
        .mint_delegation_offer(
            &org,
            OWNER,
            MintOfferRequest {
                items: vec![OfferItemSpec {
                    connection_id: connection_id.to_owned(),
                    actions: Some(vec!["repository.read".into()]),
                    resources: None,
                    expires_in_seconds: None,
                    budgets: None,
                    execution_mode: mode,
                    required: true,
                    dependencies: vec![],
                }],
                ttl_seconds: None,
            },
            &state.claim_pepper,
        )
        .await
        .expect("mint");
    let manifest = state
        .connection_broker
        .present_delegation_offer(&minted.claim_token)
        .await
        .expect("present");
    let delegations = state
        .connection_broker
        .claim_delegation_offer(
            ClaimOfferRequest {
                claim_token: minted.claim_token.clone(),
                user_code: minted.user_code.clone(),
                accepted_item_ids: vec![manifest.items[0].id.clone()],
            },
            GUEST,
            &state.claim_pepper,
        )
        .await
        .expect("claim");
    delegations[0].id.clone()
}

async fn body_json(response: Response) -> Value {
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .expect("body");
    serde_json::from_slice(&bytes).expect("json")
}

/// Model a request persisted before relay execution was disabled.
async fn seed_request(
    state: &AppState,
    org: OrganizationId,
    delegation: &str,
    request_state: &str,
) -> (String, String) {
    let resolved = state
        .connection_broker
        .find_live_delegation_by_id(GUEST, delegation)
        .await
        .unwrap()
        .unwrap();
    let id = format!("rreq_{}", uuid::Uuid::now_v7().simple());
    let digest = format!("sha256:{}", "0".repeat(64));
    let now = Utc::now();
    sqlx::query(
        "INSERT INTO relay_requests
         (id, delegation_id, connection_id, organization_id, holder_subject, delegate_subject,
          operation, resource, parameters_json, request_digest, state, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(delegation)
    .bind(&resolved.connection_id)
    .bind(org.to_string())
    .bind(OWNER)
    .bind(GUEST)
    .bind("repository.read")
    .bind("repo:acme/catalog")
    .bind(r#"{"private_parameter":"relay-sentinel"}"#)
    .bind(&digest)
    .bind(request_state)
    .bind((now + chrono::Duration::minutes(2)).to_rfc3339())
    .bind(now.to_rfc3339())
    .execute(state.connection_broker.pool())
    .await
    .unwrap();
    (id, digest)
}

#[path = "relay_authority_tests.rs"]
mod authority;

#[path = "relay_tenant_tests.rs"]
mod tenant;
