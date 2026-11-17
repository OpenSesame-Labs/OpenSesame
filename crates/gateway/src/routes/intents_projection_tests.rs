//! AT-FGA-STALE: delayed `OpenFGA` projection cannot authorize dispatch.

use super::*;
use crate::app_state::test_demo_state;
use crate::routes::intents::ResolvedInvocation;
use chrono::{Duration, Utc};
use opensesame_domain::{
    ConnectionAuthorityBinding, ConnectionId, ConnectionRef, EgressBinding, Grant,
    GrantConstraints, GrantId, InvokeLevel, OfflineUse, OrganizationId, PrincipalId, ProjectId,
};
use opensesame_provider_openfga::{grant_to_openfga_tuples, testkit::FakeRemotePdp, RemotePdp};
use opensesame_storage::authority::{
    AuthorityIssue, NewAccessDomain, PermissionEntry, ProjectionMark,
};

async fn assert_refusal(response: Response, status: StatusCode, code: &str) {
    assert_eq!(response.status(), status);
    let body = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["error"], code);
}

fn sample_grant(id: GrantId, org: OrganizationId, connection_id: ConnectionId) -> Grant {
    let now = Utc::now();
    Grant {
        id,
        version: 1,
        issuer_principal_id: PrincipalId::new(),
        beneficiary_principal_id: PrincipalId::new(),
        actor_id: None,
        client_id: None,
        actor_instance_id: None,
        proof_key_thumbprint: None,
        organization_id: org,
        project_id: Some(ProjectId::new()),
        environment_id: None,
        connection_id: Some(connection_id),
        actions: vec!["repository.read".into()],
        resources: vec!["repo:acme/catalog".into()],
        constraints: GrantConstraints {
            audiences: vec!["https://api.github.com".into()],
            not_before: None,
            expires_at: now + Duration::hours(1),
            required_assurance: None,
            authentication_max_age_seconds: None,
            allowed_networks: vec![],
            parameter_rules_digest: None,
            budgets: std::collections::BTreeMap::default(),
            maximum_delegation_depth: 1,
            offline_use: OfflineUse::Forbidden,
            raw_credential_export: false,
        },
        parent_grant_id: None,
        delegation_depth: 0,
        created_at: now,
        revoked_at: None,
    }
}

async fn projection_fixture() -> (AppState, OrganizationId, ResolvedInvocation) {
    let mut state = test_demo_state().await;
    state.openfga = None;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let org_s = org.to_string();
    let grant_id = GrantId::new();
    let grant_s = grant_id.to_string();
    let connection_id = ConnectionId::new();
    sqlx::query(
        "INSERT INTO grants (id, organization_id, body_json, revoked_at, created_at) \
         VALUES (?, ?, '{}', NULL, ?)",
    )
    .bind(&grant_s)
    .bind(&org_s)
    .bind(Utc::now().to_rfc3339())
    .execute(state.db.pool())
    .await
    .unwrap();
    state
        .db
        .create_access_domain(&NewAccessDomain {
            id: "adom:fga-stale",
            organization_id: &org_s,
            parent_id: None,
            project_id: None,
        })
        .await
        .unwrap();
    let issue = AuthorityIssue {
        grant_id: &grant_s,
        organization_id: &org_s,
        domain_id: "adom:fga-stale",
        parent_grant_id: None,
        issuance_basis: "root",
        lineage_digest: "d",
        policy_digest: "d",
        role_revision: None,
        offer_id: None,
        delegation_depth_remaining: 1,
        not_before: Utc::now() - Duration::minutes(1),
        expires_at: Utc::now() + Duration::hours(1),
        evidence_id: None,
    };
    let entry = PermissionEntry {
        resource_selector: "repo:acme/catalog".into(),
        provider_operation_id: "repository.read".into(),
        action_set_json: "[\"repository.read\"]".into(),
        parameter_constraints_json: "{}".into(),
        audience_set_json: "[]".into(),
        manifest_digest: "d".into(),
    };
    assert!(state.db.issue_authority(&issue, &[entry]).await.unwrap());
    state
        .db
        .mark_projection_dirty(&ProjectionMark {
            store: "openfga",
            organization_id: &org_s,
            subject_kind: "grant",
            subject_id: &grant_s,
            committed_revision: 1,
        })
        .await
        .unwrap();
    let resolved = ResolvedInvocation {
        grant: sample_grant(grant_id, org, connection_id),
        lineage: None,
        delegation_chain: vec![],
        connection_id,
        principal_id: PrincipalId::new(),
        binding: ConnectionAuthorityBinding {
            connection_ref: ConnectionRef::new(org, None, "github", connection_id).unwrap(),
            internal_secret: None,
            credential_handle: None,
            egress: EgressBinding {
                scheme: "https".into(),
                authorities: vec!["api.github.com".into()],
                path_prefixes: vec![],
                allow_redirects_cross_authority: false,
            },
            max_invoke_level: InvokeLevel::TypedOperation,
        },
        connection_policy_id: "github".into(),
        spend_budget: None,
        broker_connection: true,
    };
    (state, org, resolved)
}

async fn at_fga_stale_freshness_fence_denies_before_dispatch() {
    let (state, org, resolved) = projection_fixture().await;
    let err = authorize_openfga(
        &state,
        &org.to_string(),
        "user:alice",
        &resolved,
        "repository.read",
        "repo:acme/catalog",
    )
    .await
    .expect_err("stale projection must deny");
    assert_eq!(err.status(), StatusCode::FORBIDDEN);
}

async fn check_with_pdp(
    state: &AppState,
    pdp: &dyn RemotePdp,
    org: &str,
    resolved: &ResolvedInvocation,
    subject: &str,
    resource: &str,
) -> Result<(), Response> {
    authorize_openfga_with_pdp(
        state,
        Some(pdp),
        org,
        subject,
        resolved,
        "repository.read",
        resource,
    )
    .await
}

async fn mark_fresh(state: &AppState, org: &str, resolved: &ResolvedInvocation) {
    let grant = resolved.grant.id.to_string();
    assert!(state
        .db
        .record_projection_applied(
            &ProjectionMark {
                store: "openfga",
                organization_id: org,
                subject_kind: "grant",
                subject_id: &grant,
                committed_revision: 1,
            },
            None,
        )
        .await
        .unwrap());
}

async fn stale_projection_wins_before_an_unavailable_pdp_is_consulted() {
    let (state, org, resolved) = projection_fixture().await;
    let org = org.to_string();
    let subject = resolved.grant.beneficiary_principal_id.to_string();
    let pdp = FakeRemotePdp::new();
    pdp.set_unavailable(true).unwrap();
    let stale = check_with_pdp(&state, &pdp, &org, &resolved, &subject, "repo:acme/catalog")
        .await
        .expect_err("a stale projection must fail before the PDP");
    assert_refusal(stale, StatusCode::FORBIDDEN, "projection_stale").await;
    mark_fresh(&state, &org, &resolved).await;
    let outage = check_with_pdp(&state, &pdp, &org, &resolved, &subject, "repo:acme/catalog")
        .await
        .expect_err("a fresh projection must reach the unavailable PDP");
    assert_refusal(
        outage,
        StatusCode::SERVICE_UNAVAILABLE,
        "openfga_unavailable",
    )
    .await;
    // Existing behavior when the PDP is unconfigured and the mark is fresh.
    assert!(authorize_openfga(
        &state,
        &org,
        &subject,
        &resolved,
        "repository.read",
        "repo:acme/catalog"
    )
    .await
    .is_ok());
}

async fn fresh_projection_checks_the_grants_real_projected_tuples() {
    let (state, org, mut resolved) = projection_fixture().await;
    let org = org.to_string();
    let subject = resolved.grant.beneficiary_principal_id.to_string();
    let pdp = FakeRemotePdp::new();
    let tuples = grant_to_openfga_tuples(&resolved.grant).unwrap();
    for tuple in &tuples {
        pdp.allow(tuple).unwrap();
    }
    mark_fresh(&state, &org, &resolved).await;
    assert!(
        check_with_pdp(&state, &pdp, &org, &resolved, &subject, "repo:acme/catalog")
            .await
            .is_ok()
    );
    let other_subject = check_with_pdp(
        &state,
        &pdp,
        &org,
        &resolved,
        "different-subject",
        "repo:acme/catalog",
    )
    .await
    .expect_err("a different subject must deny");
    assert_refusal(other_subject, StatusCode::FORBIDDEN, "openfga_denied").await;

    let original = resolved.connection_id;
    resolved.connection_id = ConnectionId::new();
    let other_connection =
        check_with_pdp(&state, &pdp, &org, &resolved, &subject, "repo:acme/catalog")
            .await
            .expect_err("a different connection must deny");
    assert_refusal(other_connection, StatusCode::FORBIDDEN, "openfga_denied").await;
    resolved.connection_id = original;
    let connection_object = original.to_string();
    let connection_tuple = tuples
        .iter()
        .find(|tuple| tuple.object == connection_object && tuple.relation == "user")
        .unwrap();
    pdp.revoke(connection_tuple).unwrap();
    let revoked = check_with_pdp(&state, &pdp, &org, &resolved, &subject, "repo:acme/catalog")
        .await
        .expect_err("a removed relationship must deny");
    assert_refusal(revoked, StatusCode::FORBIDDEN, "openfga_denied").await;

    pdp.set_unavailable(true).unwrap();
    let unmapped = check_with_pdp(&state, &pdp, &org, &resolved, &subject, "connection:other")
        .await
        .expect_err("a mismatched connection must fail before the PDP check");
    assert_refusal(unmapped, StatusCode::FORBIDDEN, "openfga_unmapped").await;
}

async fn legacy_grant_without_a_sidecar_keeps_its_existing_pdp_skip() {
    let (state, org, mut resolved) = projection_fixture().await;
    let org = org.to_string();
    let legacy_grant = GrantId::new();
    sqlx::query(
        "INSERT INTO grants (id, organization_id, body_json, revoked_at, created_at) \
         VALUES (?, ?, '{}', NULL, ?)",
    )
    .bind(legacy_grant.to_string())
    .bind(&org)
    .bind(Utc::now().to_rfc3339())
    .execute(state.db.pool())
    .await
    .unwrap();
    resolved.grant.id = legacy_grant;
    let pdp = FakeRemotePdp::new();
    pdp.set_unavailable(true).unwrap();
    assert!(
        check_with_pdp(&state, &pdp, &org, &resolved, "legacy", "repo:acme/catalog")
            .await
            .is_ok()
    );
}

#[test]
#[ignore = "child helper invoked only with a cleared environment"]
fn projection_gate_child() {
    if std::env::var_os("OPENSESAME_TEST_PROJECTION_GATE_CHILD").is_none() {
        return;
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        at_fga_stale_freshness_fence_denies_before_dispatch().await;
        stale_projection_wins_before_an_unavailable_pdp_is_consulted().await;
        fresh_projection_checks_the_grants_real_projected_tuples().await;
        legacy_grant_without_a_sidecar_keeps_its_existing_pdp_skip().await;
    });
    println!("OPENSESAME_PROJECTION_GATE_EXECUTED");
}

#[test]
fn projection_gate_runs_without_ambient_provider_configuration() {
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .env_clear()
        .env("OPENSESAME_TEST_PROJECTION_GATE_CHILD", "1")
        .env("OPENSESAME_TASKBUS", "memory")
        .args([
            "--exact",
            "routes::intents_projection::tests::projection_gate_child",
            "--ignored",
            "--nocapture",
        ])
        .output()
        .expect("launch isolated projection tests");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "projection child failed: {stdout} {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        stdout.contains("OPENSESAME_PROJECTION_GATE_EXECUTED"),
        "projection child did not run: {stdout}"
    );
}
