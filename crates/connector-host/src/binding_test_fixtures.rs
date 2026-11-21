use crate::{opensesame_param_digest, InvokeRequest};
use opensesame_domain::{
    ActorId, ConnectionId, DetachedProof, Grant, GrantConstraints, GrantId, Intent, IntentId,
    OfflineUse, OrganizationId, PrincipalId, ValidatedGrantChain,
};
use opensesame_time::{Duration, Utc};
use serde_json::json;

pub(crate) fn owner() -> (Intent, Grant, InvokeRequest) {
    let now = Utc::now();
    let organization = OrganizationId::new();
    let principal = PrincipalId::new();
    let connection = ConnectionId::new();
    let parameters = json!({"query": "original"});
    let request = InvokeRequest {
        operation: "repository.read".into(),
        resource: "repo:example/one".into(),
        audience: "https://api.github.com".into(),
        parameters_digest: opensesame_param_digest(&parameters),
        parameters,
        authorized_operation: "repository.read".into(),
        invoke_level: Some(1),
        connection_ref: "demo-conn".into(),
    };
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
            expires_at: now + Duration::hours(1),
            required_assurance: None,
            authentication_max_age_seconds: None,
            allowed_networks: vec![],
            parameter_rules_digest: None,
            budgets: Default::default(),
            maximum_delegation_depth: 1,
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
        expires_at: now + Duration::minutes(5),
        parent_invocation_id: None,
        delegation_chain: vec![],
        proof: DetachedProof {
            algorithm: "test".into(),
            key_thumbprint: "test".into(),
            signature: "test".into(),
        },
    };
    (intent, grant, request)
}

pub(crate) fn delegated() -> (Intent, Grant, InvokeRequest, ValidatedGrantChain) {
    let (mut intent, root, request) = owner();
    let mut child = root.clone();
    child.id = GrantId::new();
    child.beneficiary_principal_id = PrincipalId::new();
    child.parent_grant_id = Some(root.id);
    child.delegation_depth = 1;
    child.constraints.maximum_delegation_depth = 0;
    child.constraints.expires_at -= Duration::minutes(1);
    intent.principal_id = child.beneficiary_principal_id;
    intent.delegation_chain = vec![root.id, child.id];
    let chain = ValidatedGrantChain::try_validate(&[root, child.clone()], Utc::now(), 0).unwrap();
    (intent, child, request, chain)
}
