use super::enabled::{accepts_binding, bridge_for_test};
use crate::app_state::test_demo_state;
use opensesame_connector_host::wasm::{EgressRequest, HostEgress};
use opensesame_connector_host::InvocationBinding;
use opensesame_domain::{DetachedProof, Intent, IntentId, InvocationId};
use opensesame_time::{Duration, Utc};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn owner_wasm_egress_requires_the_intended_durable_connection_and_tenant() {
    let state = test_demo_state().await;
    let boot = state.bootstrap.lock().unwrap().as_ref().unwrap().clone();
    let now = Utc::now();
    let intent = Intent {
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
        normalized_parameters_hash: Intent::parameters_hash(&json!({})).unwrap(),
        body_hash: None,
        nonce: "nonce".into(),
        idempotency_key: "key".into(),
        issued_at: now,
        expires_at: now + Duration::minutes(5),
        parent_invocation_id: None,
        delegation_chain: vec![],
        proof: DetachedProof {
            algorithm: "test".into(),
            key_thumbprint: "test".into(),
            signature: "test".into(),
        },
    };
    let id = "github";
    let bound = InvocationBinding::from_intent(
        InvocationId::new(),
        &intent,
        &boot.grant,
        "user:owner",
        id,
        None,
    )
    .unwrap();
    assert_eq!(accepts_binding(&bound, id, id), Some(boot.connection));
    assert!(accepts_binding(&bound, "different-policy", id).is_none());
    assert!(accepts_binding(&bound, id, "other-provider").is_none());
    let other_policy = InvocationBinding::from_intent(
        InvocationId::new(),
        &intent,
        &boot.grant,
        "user:owner",
        "other-policy",
        None,
    )
    .unwrap();
    assert!(accepts_binding(&other_policy, "other-policy", id).is_none());

    // Exercise the real bridge with a mismatched policy. It must refuse
    // before attempting to resolve or use any connection credential.
    let bridge = bridge_for_test(Arc::clone(&state.connection_broker), id);
    let request = EgressRequest {
        method: "GET".into(),
        url: "https://api.github.com/repos".into(),
        headers: vec![],
        body: vec![],
    };
    assert_eq!(
        bridge
            .authorized_request(&other_policy, "other-policy", request)
            .unwrap_err(),
        "invocation binding denied"
    );

    let mut no_connection = intent.clone();
    no_connection.connection_id = None;
    let mut unscoped_grant = boot.grant.clone();
    unscoped_grant.connection_id = None;
    let unscoped = InvocationBinding::from_intent(
        InvocationId::new(),
        &no_connection,
        &unscoped_grant,
        "user:owner",
        "github",
        None,
    )
    .unwrap();
    assert!(accepts_binding(&unscoped, id, id).is_none());
}
