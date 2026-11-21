//! An actual component import exercises the binding from guest to host.

use super::*;
use opensesame_connector_host::{HostError, InvocationBinding};
use opensesame_domain::{
    ActorId, ConnectionId, DetachedProof, Grant, GrantConstraints, GrantId, Intent, IntentId,
    InvocationId, OfflineUse, OrganizationId, PrincipalId,
};
use opensesame_time::{Duration as TimeDuration, Utc};
use std::sync::Mutex;

const HTTP_GUEST: &str = include_str!("egress.wat");

#[derive(Debug, PartialEq)]
struct Recorded {
    invocation_id: InvocationId,
    connection_ref: String,
    method: String,
    url: String,
}

#[derive(Default)]
struct RecordingBackend(Mutex<Vec<Recorded>>);

impl HostEgress for RecordingBackend {
    fn authorized_request(
        &self,
        binding: &InvocationBinding,
        connection_ref: &str,
        request: EgressRequest,
    ) -> Result<EgressResponse, String> {
        self.0.lock().unwrap().push(Recorded {
            invocation_id: binding.invocation_id(),
            connection_ref: connection_ref.to_owned(),
            method: request.method,
            url: request.url,
        });
        Ok(EgressResponse {
            status: 200,
            headers: vec![],
            body: vec![],
        })
    }

    fn sign(
        &self,
        _binding: &InvocationBinding,
        _purpose: &str,
        _digest: &[u8],
    ) -> Result<Vec<u8>, String> {
        Err("unexpected signing request".into())
    }

    fn oauth_acquire(
        &self,
        _binding: &InvocationBinding,
        _connection_ref: &str,
        _resource: Option<&str>,
        _audience: Option<&str>,
        _scopes: &[String],
    ) -> Result<u32, String> {
        Err("unexpected token request".into())
    }

    fn authenticated_request(
        &self,
        _binding: &InvocationBinding,
        _connection_ref: &str,
        _token_handle: u32,
        _request: EgressRequest,
    ) -> Result<EgressResponse, String> {
        Err("unexpected authenticated request".into())
    }
}

pub(super) fn owner_binding(
    request: &InvokeRequest,
    invocation: InvocationId,
) -> InvocationBinding {
    let now = Utc::now();
    let organization = OrganizationId::new();
    let principal = PrincipalId::new();
    let connection = ConnectionId::new();
    let grant = Grant {
        id: GrantId::new(),
        version: 1,
        issuer_principal_id: principal,
        beneficiary_principal_id: principal,
        actor_id: None,
        client_id: None,
        actor_instance_id: None,
        proof_key_thumbprint: None,
        organization_id: organization,
        project_id: None,
        environment_id: None,
        connection_id: Some(connection),
        actions: vec![request.operation.clone()],
        resources: vec![request.resource.clone()],
        constraints: GrantConstraints {
            audiences: vec![request.audience.clone()],
            not_before: None,
            expires_at: now + TimeDuration::hours(1),
            required_assurance: None,
            authentication_max_age_seconds: None,
            allowed_networks: vec![],
            parameter_rules_digest: None,
            budgets: Default::default(),
            maximum_delegation_depth: 0,
            offline_use: OfflineUse::Forbidden,
            raw_credential_export: false,
        },
        parent_grant_id: None,
        delegation_depth: 0,
        created_at: now,
        revoked_at: None,
    };
    let intent = Intent {
        id: IntentId::new(),
        organization_id: organization,
        project_id: None,
        principal_id: principal,
        actor_id: ActorId::new(),
        actor_instance_id: None,
        client_id: None,
        operator_id: None,
        connection_id: Some(connection),
        operation: request.operation.clone(),
        resource: request.resource.clone(),
        audience: request.audience.clone(),
        normalized_parameters_hash: request.parameters_digest.clone(),
        body_hash: None,
        nonce: "nonce".into(),
        idempotency_key: "key".into(),
        issued_at: now,
        expires_at: now + TimeDuration::minutes(5),
        parent_invocation_id: None,
        delegation_chain: vec![],
        proof: DetachedProof {
            algorithm: "test".into(),
            key_thumbprint: "test".into(),
            signature: "test".into(),
        },
    };
    InvocationBinding::from_intent(
        invocation,
        &intent,
        &grant,
        "user:owner",
        &request.connection_ref,
        None,
    )
    .unwrap()
}

#[test]
fn real_component_import_requires_and_preserves_invocation_binding() {
    let bytes = HTTP_GUEST.as_bytes();
    let manifest = ConnectorManifest::from_yaml(
        &MANIFEST_TEMPLATE
            .replace("DIGEST", &digest_of(bytes))
            .replace("hosts: [api.example.com]", "hosts: [api.github.com]"),
    )
    .unwrap();
    let backend = Arc::new(RecordingBackend::default());
    let connector = WasmConnector::load(
        manifest,
        bytes,
        &pinned_policy(&digest_of(bytes)),
        backend.clone(),
        GuestLimits::default(),
    )
    .expect("the component imports real host HTTP");
    let mut request = request("echo.read");
    // The guest's hardcoded URL must sit on the bound audience host.
    request.audience = "https://api.github.com".into();

    // Unbound invoke must not start the guest or mint a successful receipt
    // after the HTTP import is denied.
    assert!(matches!(
        connector.invoke(&request),
        Err(HostError::InvocationBindingMismatch)
    ));
    assert!(backend.0.lock().unwrap().is_empty());

    let first = InvocationId::new();
    let second = InvocationId::new();
    let binding = owner_binding(&request, first);
    let next_binding = owner_binding(&request, second);
    assert!(connector.invoke_bound(&request, &binding).unwrap().ok);
    assert!(connector.invoke_bound(&request, &next_binding).unwrap().ok);
    let expected = |invocation_id| Recorded {
        invocation_id,
        connection_ref: request.connection_ref.clone(),
        method: "GET".into(),
        url: "https://api.github.com/repos".into(),
    };
    assert_eq!(
        *backend.0.lock().unwrap(),
        vec![expected(first), expected(second)]
    );
}
