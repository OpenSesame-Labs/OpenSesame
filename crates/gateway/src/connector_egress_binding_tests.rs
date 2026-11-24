use super::enabled::{accepts_binding, bridge_for_test};
use crate::app_state::test_demo_state;
use opensesame_connector_host::wasm::{EgressRequest, HostEgress};
use opensesame_connector_host::InvocationBinding;
use opensesame_domain::{
    ConnectionId, DetachedProof, GrantId, Intent, IntentId, InvocationId, ValidatedGrantChain,
};
use opensesame_time::{Duration, Utc};
use serde_json::json;
use std::sync::Arc;

fn sample_intent(boot: &crate::app_state::Bootstrap, connection: Option<ConnectionId>) -> Intent {
    let now = Utc::now();
    Intent {
        id: IntentId::new(),
        organization_id: boot.org,
        project_id: Some(boot.project),
        principal_id: boot.principal,
        actor_id: boot.actor,
        actor_instance_id: None,
        client_id: None,
        operator_id: None,
        connection_id: connection,
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
    }
}

#[tokio::test]
async fn owner_wasm_egress_requires_the_intended_durable_connection_and_tenant() {
    let state = test_demo_state().await;
    let boot = state.bootstrap.lock().unwrap().as_ref().unwrap().clone();
    let intent = sample_intent(&boot, Some(boot.connection));
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

/// INV-D2 gateway: every realizable Lean case of `accepts_binding`, and the
/// real bridge, which must refuse exactly those bindings before any egress.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "run by verify:invocation-formal with OPENSESAME_INVOCATION_EFFECT_VECTORS"]
async fn lean_registration_vectors_match_the_gateway() {
    let state = test_demo_state().await;
    let boot = state.bootstrap.lock().unwrap().as_ref().unwrap().clone();
    let now = Utc::now();
    let bridge = bridge_for_test(Arc::clone(&state.connection_broker), "github");
    let path = std::env::var("OPENSESAME_INVOCATION_EFFECT_VECTORS").expect("Lean vector file");
    let mut cases = 0;
    for line in std::fs::read_to_string(path).unwrap().lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        let ["d2-accept", connection, grant_connection, delegated, policy, provider, activity, expected] =
            fields[..]
        else {
            continue;
        };
        // A fresh connection id has no broker row, so an accepted binding
        // reaches the broker and is refused there, never by the capture.
        let id = (connection == "1").then(ConnectionId::new);
        let mut intent = sample_intent(&boot, id);
        let mut root = boot.grant.clone();
        root.connection_id = id.filter(|_| grant_connection == "same");
        root.constraints.maximum_delegation_depth = 1;
        match activity {
            "active" => {}
            "expired" => root.constraints.expires_at = now - Duration::minutes(1),
            "revoked" => root.revoked_at = Some(now),
            "not-yet-valid" => root.constraints.not_before = Some(now + Duration::minutes(5)),
            _ => panic!("invalid activity vector: {line}"),
        }
        let (grant, lineage) = if delegated == "1" {
            let mut child = root.clone();
            child.id = GrantId::new();
            child.parent_grant_id = Some(root.id);
            child.delegation_depth = 1;
            child.constraints.maximum_delegation_depth = 0;
            intent.delegation_chain = vec![root.id, child.id];
            let chain = ValidatedGrantChain::try_validate(&[root, child.clone()], now, 0);
            (child, Some(chain.unwrap()))
        } else {
            (root, None)
        };
        let policy_id = if policy == "1" {
            "github"
        } else {
            "other-policy"
        };
        let registered = if provider == "1" {
            "github"
        } else {
            "other-provider"
        };
        let binding = InvocationBinding::from_intent(
            InvocationId::new(),
            &intent,
            &grant,
            "user:owner",
            policy_id,
            lineage.as_ref(),
        )
        .unwrap();
        let accepted = accepts_binding(&binding, "github", registered);
        assert!(accepted.is_none() || accepted == id, "vector: {line}");
        assert_eq!(
            u8::from(accepted.is_some()).to_string(),
            expected,
            "vector: {line}"
        );
        let bridge_owned;
        let bridge = if registered == "github" {
            &bridge
        } else {
            bridge_owned = bridge_for_test(Arc::clone(&state.connection_broker), registered);
            &bridge_owned
        };
        let request = EgressRequest {
            method: "GET".into(),
            url: "https://api.github.com/repos".into(),
            headers: vec![],
            body: vec![],
        };
        let refused = bridge
            .authorized_request(&binding, "github", request)
            .unwrap_err();
        let denied = refused == "invocation binding denied";
        assert_eq!(denied, expected == "0", "vector: {line}: {refused}");
        cases += 1;
    }
    assert_eq!(cases, 60, "vector: registration case count");
    println!("invocation-formal: {cases} gateway registration vectors matched");
}
