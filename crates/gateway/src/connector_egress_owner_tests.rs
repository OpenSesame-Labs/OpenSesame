//! Real owner egress uses a provider name and a different durable UUID.

use super::enabled::bridge_for_test;
use crate::app_state::test_demo_state;
use axum::{
    extract::State,
    http::{header, HeaderMap},
    routing::get,
    Json, Router,
};
use opensesame_connection_broker::{
    crypto,
    store::{self, ConnectionRow},
    token::TokenSet,
    BrokerConfig, ConnectionBroker, ConnectionStatus,
};
use opensesame_connector_host::{
    wasm::{EgressRequest, HostEgress},
    InvocationBinding,
};
use opensesame_domain::{
    ConnectionId, DetachedProof, EgressBinding, Intent, IntentId, InvocationId,
};
use opensesame_time::{Duration, Utc};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

const TEST_KEY: [u8; 32] = [42; 32];
const TEST_TOKEN: &str = "receipt-test-owner-token";

async fn record_request(
    State(seen): State<Arc<Mutex<Vec<String>>>>,
    headers: HeaderMap,
) -> Json<Value> {
    seen.lock().unwrap().push(
        headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_owned(),
    );
    Json(json!({"ok": true}))
}

fn request(url: &str) -> EgressRequest {
    EgressRequest {
        method: "GET".into(),
        url: url.into(),
        headers: vec![],
        body: vec![],
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn owner_provider_mapping_uses_the_bound_connection_and_rejects_substitution() {
    let state = test_demo_state().await;
    let boot = state.bootstrap.lock().unwrap().as_ref().unwrap().clone();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server_seen = Arc::clone(&seen);
    let server = tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            Router::new()
                .route("/resource", get(record_request))
                .with_state(server_seen),
        )
        .await;
    });
    let url = format!("http://{address}/resource");
    let now = Utc::now();
    let owner = boot.principal.to_string();
    let connection = ConnectionId::new();
    let row = ConnectionRow {
        id: connection.to_string(),
        organization_id: boot.org.to_string(),
        project_id: Some(boot.project.to_string()),
        provider_id: "github".into(),
        integration_id: "deployment:github".into(),
        logical_name: "owner-wasm".into(),
        display_name: "owner-wasm".into(),
        status: ConnectionStatus::Active,
        status_detail: None,
        requested_scopes: vec![],
        granted_scopes: vec![],
        account_label: None,
        owner_kind: "user".into(),
        owner_subject: Some(owner.clone()),
        shareability: "private".into(),
        max_invoke_level: 1,
        materialization: "deny".into(),
        egress: EgressBinding {
            scheme: "http".into(),
            authorities: vec![address.to_string()],
            path_prefixes: vec!["/resource".into()],
            allow_redirects_cross_authority: false,
        },
        created_at: now,
        updated_at: now,
    };
    store::insert_connection(state.db.pool(), &row)
        .await
        .unwrap();
    let broker = Arc::new(
        ConnectionBroker::new(
            state.db.pool().clone(),
            BrokerConfig::in_memory(Some(TEST_KEY), "http://127.0.0.1:8787"),
        )
        .unwrap(),
    );
    let grant = broker
        .owner_invocation_grant(&boot.org, &row.id, &owner)
        .await
        .unwrap();
    let tokens = TokenSet {
        access_token: TEST_TOKEN.into(),
        refresh_token: None,
        token_type: "Bearer".into(),
        expires_at: None,
        scopes: vec![],
        configuration: Default::default(),
    };
    let sealed = crypto::seal(
        &TEST_KEY,
        &row.id,
        &row.organization_id,
        &serde_json::to_vec(&tokens).unwrap(),
    )
    .unwrap();
    sqlx::query(
        "INSERT INTO connection_credentials \
         (connection_id, version, ciphertext, nonce, aad_digest, token_type, \
          expires_at, refreshable, last_refreshed_at, configured_fields, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL, '[]', ?, ?)",
    )
    .bind(&row.id)
    .bind("test-version")
    .bind(&sealed.ciphertext)
    .bind(&sealed.nonce)
    .bind(&sealed.aad_digest)
    .bind("Bearer")
    .bind(now.to_rfc3339())
    .bind(now.to_rfc3339())
    .execute(state.db.pool())
    .await
    .unwrap();

    let intent = Intent {
        id: IntentId::new(),
        organization_id: boot.org,
        project_id: Some(boot.project),
        principal_id: grant.beneficiary_principal_id,
        actor_id: boot.actor,
        actor_instance_id: None,
        client_id: None,
        operator_id: None,
        connection_id: Some(connection),
        operation: "repository.read".into(),
        resource: "repo:acme/catalog".into(),
        audience: format!("http://{address}"),
        normalized_parameters_hash: Intent::parameters_hash(&json!({})).unwrap(),
        body_hash: None,
        nonce: "test-nonce".into(),
        idempotency_key: "test-key".into(),
        issued_at: now,
        expires_at: now + Duration::minutes(5),
        parent_invocation_id: None,
        delegation_chain: vec![grant.id],
        proof: DetachedProof {
            algorithm: "test".into(),
            key_thumbprint: "test".into(),
            signature: "test".into(),
        },
    };
    let binding = InvocationBinding::from_intent(
        InvocationId::new(),
        &intent,
        &grant,
        &owner,
        "github",
        None,
    )
    .unwrap();
    let bridge = bridge_for_test(Arc::clone(&broker), boot.org, "github");
    let response = bridge
        .authorized_request(&binding, "github", request(&url))
        .unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(
        serde_json::from_slice::<Value>(&response.body).unwrap(),
        json!({"ok": true})
    );
    assert_eq!(
        seen.lock().unwrap().as_slice(),
        &[format!("Bearer {TEST_TOKEN}")]
    );

    // A stored row cannot be silently rebound to a different provider or owner.
    for (column, value) in [
        ("provider_id", "other-provider"),
        ("owner_subject", "other-owner"),
    ] {
        let statement = match column {
            "provider_id" => "UPDATE connections SET provider_id = ? WHERE id = ?",
            _ => "UPDATE connections SET owner_subject = ? WHERE id = ?",
        };
        sqlx::query(statement)
            .bind(value)
            .bind(&row.id)
            .execute(state.db.pool())
            .await
            .unwrap();
        assert_eq!(
            bridge
                .authorized_request(&binding, "github", request(&url))
                .unwrap_err(),
            "owner egress unavailable"
        );
        let restore = match column {
            "provider_id" => "UPDATE connections SET provider_id = ? WHERE id = ?",
            _ => "UPDATE connections SET owner_subject = ? WHERE id = ?",
        };
        let original = if column == "provider_id" {
            "github"
        } else {
            &owner
        };
        sqlx::query(restore)
            .bind(original)
            .bind(&row.id)
            .execute(state.db.pool())
            .await
            .unwrap();
    }

    // Even another connection owned by the same subject cannot be substituted
    // by changing a copied grant: the durable root grant must still match.
    let other = ConnectionId::new();
    let mut other_row = row.clone();
    other_row.id = other.to_string();
    other_row.logical_name = "owner-wasm-other".into();
    store::insert_connection(state.db.pool(), &other_row)
        .await
        .unwrap();
    let mut altered_intent = intent.clone();
    altered_intent.connection_id = Some(other);
    let mut altered_grant = grant.clone();
    altered_grant.connection_id = Some(other);
    let substituted = InvocationBinding::from_intent(
        InvocationId::new(),
        &altered_intent,
        &altered_grant,
        &owner,
        "github",
        None,
    )
    .unwrap();
    assert_eq!(
        bridge
            .authorized_request(&substituted, "github", request(&url))
            .unwrap_err(),
        "owner egress unavailable"
    );

    sqlx::query("UPDATE grants SET revoked_at = ? WHERE id = ?")
        .bind(Utc::now().to_rfc3339())
        .bind(grant.id.to_string())
        .execute(state.db.pool())
        .await
        .unwrap();
    assert_eq!(
        bridge
            .authorized_request(&binding, "github", request(&url))
            .unwrap_err(),
        "owner egress unavailable"
    );
    assert_eq!(
        seen.lock().unwrap().len(),
        1,
        "refusals reached the provider"
    );
    server.abort();
}
