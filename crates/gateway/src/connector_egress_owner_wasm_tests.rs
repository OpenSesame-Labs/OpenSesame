//! Owner wasm egress preserves the upstream status and headers.

use super::enabled::bridge_for_test;
use crate::app_state::test_demo_state;
use axum::{
    http::{header, StatusCode},
    response::IntoResponse,
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
use std::sync::Arc;

const TEST_KEY: [u8; 32] = [42; 32];
const TEST_TOKEN: &str = "receipt-test-owner-token";
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn owner_wasm_egress_preserves_upstream_status_and_headers() {
    let state = test_demo_state().await;
    let boot = state.bootstrap.lock().unwrap().as_ref().unwrap().clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            Router::new().route(
                "/created",
                get(|| async {
                    let mut response = (
                        StatusCode::CREATED,
                        [(header::CONTENT_TYPE, "application/json")],
                        Json(json!({"created": true})),
                    )
                        .into_response();
                    // Credential-shaped headers on a success response: the
                    // broker sink drops them and the guest boundary drops
                    // them again, whatever either layer misses.
                    let headers = response.headers_mut();
                    headers.insert(header::SET_COOKIE, "sid=upstream-secret".parse().unwrap());
                    headers.insert(
                        header::WWW_AUTHENTICATE,
                        "Bearer realm=api".parse().unwrap(),
                    );
                    headers.insert("proxy-authenticate", "Basic realm=proxy".parse().unwrap());
                    response
                }),
            ),
        )
        .await;
    });
    let url = format!("http://{address}/created");
    let now = Utc::now();
    let owner = boot.principal.to_string();
    let connection = ConnectionId::new();
    let row = ConnectionRow {
        id: connection.to_string(),
        organization_id: boot.org.to_string(),
        project_id: Some(boot.project.to_string()),
        // Plain-http loopback credentialed egress is mock-only (#2740).
        provider_id: "mock".into(),
        integration_id: "deployment:mock".into(),
        logical_name: "owner-wasm-created".into(),
        display_name: "owner-wasm-created".into(),
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
            path_prefixes: vec!["/created".into()],
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
        operation: "repository.create".into(),
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
    let binding =
        InvocationBinding::from_intent(InvocationId::new(), &intent, &grant, &owner, "mock", None)
            .unwrap();
    let bridge = bridge_for_test(Arc::clone(&broker), "mock");
    let response = bridge
        .authorized_request(
            &binding,
            "mock",
            EgressRequest {
                method: "GET".into(),
                url: url.clone(),
                headers: vec![],
                body: vec![],
            },
        )
        .unwrap();
    assert_eq!(response.status, 201);
    assert!(
        response
            .headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("content-type")),
        "guest sees upstream response headers"
    );
    for stripped in ["set-cookie", "www-authenticate", "proxy-authenticate"] {
        assert!(
            !response
                .headers
                .iter()
                .any(|(name, _)| name.eq_ignore_ascii_case(stripped)),
            "{stripped} reached the guest"
        );
    }
    assert_eq!(
        serde_json::from_slice::<Value>(&response.body).unwrap(),
        json!({"created": true})
    );
    server.abort();
}
