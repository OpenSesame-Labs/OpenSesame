use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use opensesame_domain::{ConnectionId, InvocationId, PrincipalId};
use serde_json::json;

use crate::binding_test_fixtures::{delegated, owner};
use crate::{Connector, HostError, HostRuntime, InvocationBinding, InvokeRequest, InvokeResult};

fn bound_owner() -> (InvocationBinding, InvokeRequest) {
    let (intent, grant, request) = owner();
    let binding = InvocationBinding::from_intent(
        InvocationId::new(),
        &intent,
        &grant,
        "user:owner",
        "demo-conn",
        None,
    )
    .unwrap();
    (binding, request)
}

#[test]
fn request_substitution_is_rejected_before_connector_dispatch() {
    let (binding, request) = bound_owner();
    let host = HostRuntime::default();
    assert!(host.invoke_bound("demo-conn", &request, &binding).is_ok());
    assert_eq!(
        host.invoke_bound("other", &request, &binding).unwrap_err(),
        HostError::InvocationBindingMismatch
    );

    let variants: Vec<fn(&mut InvokeRequest)> = vec![
        |r| r.connection_ref = "other".into(),
        |r| r.operation = "pull_request.create".into(),
        |r| r.authorized_operation = "pull_request.create".into(),
        |r| r.resource = "repo:example/two".into(),
        |r| r.audience = "https://other.example".into(),
        |r| r.invoke_level = Some(2),
        |r| r.parameters_digest = "other".into(),
        |r| r.parameters = json!({"query": "changed"}),
        |r| {
            r.parameters = json!({"query": "changed"});
            r.parameters_digest = crate::opensesame_param_digest(&r.parameters);
        },
    ];
    for change in variants {
        let mut changed = request.clone();
        change(&mut changed);
        assert_eq!(
            host.invoke_bound("demo-conn", &changed, &binding)
                .unwrap_err(),
            HostError::InvocationBindingMismatch
        );
    }
}

#[test]
fn captured_intent_and_grant_cannot_follow_caller_mutations() {
    let (mut intent, mut grant, request) = owner();
    let invocation = InvocationId::new();
    let original_digest = intent.digest().unwrap();
    let original_grant = grant.clone();
    let binding = InvocationBinding::from_intent(
        invocation,
        &intent,
        &grant,
        "user:owner",
        "demo-conn",
        None,
    )
    .unwrap();
    intent.resource = "repo:example/other".into();
    intent.connection_id = Some(ConnectionId::new());
    grant.actions.push("repository.write".into());
    assert_eq!(binding.invocation_id(), invocation);
    assert_eq!(binding.intent_digest(), original_digest);
    assert_eq!(binding.grant(), &original_grant);
    assert_eq!(binding.resource(), request.resource);
    assert!(binding.assert_request("demo-conn", &request).is_ok());
}

#[test]
fn malformed_or_substituted_delegation_snapshots_are_rejected() {
    let (intent, grant, _, chain) = delegated();
    assert!(InvocationBinding::from_intent(
        InvocationId::new(),
        &intent,
        &grant,
        "user:delegate",
        "demo-conn",
        None
    )
    .is_err());
    let mut altered = grant.clone();
    altered.resources.push("repo:other".into());
    // Same grant ID/version/tenant is not enough: compare the full leaf.
    assert!(InvocationBinding::from_intent(
        InvocationId::new(),
        &intent,
        &altered,
        "user:delegate",
        "demo-conn",
        Some(&chain)
    )
    .is_err());
    let mut other_principal = intent.clone();
    other_principal.principal_id = PrincipalId::new();
    assert!(InvocationBinding::from_intent(
        InvocationId::new(),
        &other_principal,
        &grant,
        "user:delegate",
        "demo-conn",
        Some(&chain)
    )
    .is_err());
    let mut other_chain = intent.clone();
    other_chain.delegation_chain[0] = opensesame_domain::GrantId::new();
    assert!(InvocationBinding::from_intent(
        InvocationId::new(),
        &other_chain,
        &grant,
        "user:delegate",
        "demo-conn",
        Some(&chain),
    )
    .is_err());
    assert!(InvocationBinding::from_intent(
        InvocationId::new(),
        &intent,
        &grant,
        "user:delegate",
        "demo-conn",
        Some(&chain)
    )
    .unwrap()
    .is_delegated());
}

struct RogueConnector(Arc<AtomicUsize>);
impl Connector for RogueConnector {
    fn id(&self) -> &str {
        "rogue"
    }
    fn version(&self) -> &str {
        "1"
    }
    fn component_digest(&self) -> &str {
        "sha256:rogue"
    }
    fn operations(&self) -> &[&str] {
        &["repository.read"]
    }
    fn invoke(&self, _request: &InvokeRequest) -> Result<InvokeResult, HostError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(InvokeResult {
            ok: true,
            safe_summary: json!({}),
            external_request_digest: None,
        })
    }
    fn invoke_bound(
        &self,
        request: &InvokeRequest,
        _binding: &InvocationBinding,
    ) -> Result<InvokeResult, HostError> {
        self.invoke(request)
    }
}

#[test]
fn only_the_host_owned_inert_mock_can_run_bound_delegated_work() {
    let (intent, grant, mut request, chain) = delegated();
    let binding = InvocationBinding::from_intent(
        InvocationId::new(),
        &intent,
        &grant,
        "user:delegate",
        "demo-conn",
        Some(&chain),
    )
    .unwrap();
    let mut host = HostRuntime::default();
    assert!(host.invoke_bound("demo-conn", &request, &binding).is_ok());

    let effects = Arc::new(AtomicUsize::new(0));
    host.policy.trusted_digests.insert("sha256:rogue".into());
    host.register_connector(Arc::new(RogueConnector(Arc::clone(&effects))))
        .unwrap();
    host.bind_connection("other", "rogue").unwrap();
    request.connection_ref = "other".into();
    let other = InvocationBinding::from_intent(
        InvocationId::new(),
        &intent,
        &grant,
        "user:delegate",
        "other",
        Some(&chain),
    )
    .unwrap();
    assert_eq!(
        host.invoke_bound("other", &request, &other).unwrap_err(),
        HostError::DelegatedExecutionUnavailable
    );
    assert_eq!(effects.load(Ordering::SeqCst), 0);
}

#[test]
fn unbound_invoke_does_not_run_the_connector() {
    let effects = Arc::new(AtomicUsize::new(0));
    let mut host = HostRuntime::default();
    host.policy.trusted_digests.insert("sha256:rogue".into());
    host.register_connector(Arc::new(RogueConnector(Arc::clone(&effects))))
        .unwrap();
    host.bind_connection("other", "rogue").unwrap();
    let (_, _, mut request) = owner();
    request.connection_ref = "other".into();
    assert_eq!(
        host.invoke("other", &request).unwrap_err(),
        HostError::InvocationBindingMismatch
    );
    assert_eq!(effects.load(Ordering::SeqCst), 0);
}

#[test]
fn frozen_binding_retains_the_verified_task_digest() {
    let (intent, grant, request) = owner();
    let mut frozen = opensesame_domain::FrozenIntentV2::from_legacy(
        &intent,
        opensesame_domain::TaskRunId::new(),
        3,
        "state-digest".into(),
        request.parameters.clone(),
    )
    .unwrap();
    let binding = InvocationBinding::from_frozen(
        InvocationId::new(),
        &frozen,
        &grant,
        "user:owner",
        "demo-conn",
        None,
    )
    .unwrap();
    assert!(binding.is_frozen());
    assert_eq!(binding.intent_digest(), frozen.intent_digest);
    assert!(binding.assert_request("demo-conn", &request).is_ok());
    let captured = binding.intent_digest().to_owned();
    frozen.canonical_arguments = json!({"query":"substituted"});
    // The captured binding does not alias the caller's frozen value.
    assert_eq!(binding.intent_digest(), captured);
    assert!(binding.assert_request("demo-conn", &request).is_ok());
    assert!(InvocationBinding::from_frozen(
        InvocationId::new(),
        &frozen,
        &grant,
        "user:owner",
        "demo-conn",
        None
    )
    .is_err());
}
