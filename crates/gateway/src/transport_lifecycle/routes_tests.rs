//! Who may reach the lifecycle routes. Trust profiles and revocation by
//! thumbprint are deployment-scoped: an owner or admin of one organization
//! gets `403`, and only the deployment operator gets through. Revoking an
//! organization's own certificate by id, and reading trust, stay with the
//! organization's configurators.

use axum::body::Body;
use axum::http::{HeaderMap, Request, StatusCode};
use opensesame_domain::{OrganizationId, OrganizationRole};
use serde_json::{json, Value};
use tower::ServiceExt as _;

use crate::app_state::AppState;
use crate::transport_lifecycle::test_support as support;

const TRUST: &str = "/api/v1/operator/transport/trust";
const REVOKE: &str = "/api/v1/operator/transport/certificates/revoke";

fn admin(state: &AppState, role: OrganizationRole) -> HeaderMap {
    crate::app_state::test_session_headers(
        state,
        crate::test_principals::P01,
        OrganizationId::new(),
        role,
    )
}

fn operator(state: &AppState) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-opensesame-operator",
        state.operator_token.parse().expect("header"),
    );
    headers
}

async fn call(
    state: &AppState,
    method: &str,
    path: &str,
    headers: HeaderMap,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(path);
    for (name, value) in &headers {
        builder = builder.header(name, value);
    }
    let body = match body {
        Some(body) => {
            builder = builder.header("content-type", "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let response = super::routes::routes()
        .with_state(state.clone())
        .oneshot(builder.body(body).expect("request"))
        .await
        .expect("response");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 128 * 1024)
        .await
        .expect("body");
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn thumbprint_revoke() -> Value {
    json!({ "thumbprint": "a".repeat(64), "reason": "key_compromise" })
}

fn empty_trust() -> Value {
    json!({ "revision": 0, "profiles": [] })
}

#[tokio::test]
async fn an_organization_admin_cannot_write_deployment_scoped_trust_or_revoke_by_thumbprint() {
    let state = support::state().await;
    for role in [OrganizationRole::Admin, OrganizationRole::Owner] {
        let (status, body) = call(
            &state,
            "PUT",
            TRUST,
            admin(&state, role),
            Some(empty_trust()),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "trust PUT as {role:?}");
        assert_eq!(body["error"], "forbidden");

        let (status, body) = call(
            &state,
            "POST",
            REVOKE,
            admin(&state, role),
            Some(thumbprint_revoke()),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::FORBIDDEN,
            "thumbprint revoke as {role:?}"
        );
        assert_eq!(body["error"], "forbidden");
    }
    // Nothing was denied and nothing was stored on their say-so.
    assert!(!state.transport_lifecycle.is_denied(&"a".repeat(64)));
    assert_eq!(
        crate::transport_lifecycle::trust::load(&state)
            .await
            .expect("load")
            .revision,
        0
    );
}

#[tokio::test]
async fn the_deployment_operator_may_write_trust_and_revoke_by_thumbprint() {
    let state = support::state().await;
    let (status, body) = call(&state, "PUT", TRUST, operator(&state), Some(empty_trust())).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["trust"]["revision"], 1);

    let (status, body) = call(
        &state,
        "POST",
        REVOKE,
        operator(&state),
        Some(thumbprint_revoke()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(state.transport_lifecycle.is_denied(&"a".repeat(64)));
}

#[tokio::test]
async fn trust_status_reports_quarantine_and_a_changed_serving_generation() {
    use crate::transport_lifecycle::trust::{self, StoredTrustProfile, TrustProfileSet};
    use opensesame_domain::transport::TrustProfileKind;
    use opensesame_transport_security::testkit::DisposableCa;
    use opensesame_transport_security::GenerationCandidate;

    let state = support::state().await;
    let server = DisposableCa::new("server")
        .issue_server("localhost")
        .identity();
    let generations = support::generations(server, &DisposableCa::new("clients"));
    let old_name = support::profile_ref("old-source.test");
    generations
        .seed_source_history(1, &std::collections::BTreeSet::from([old_name.clone()]))
        .unwrap();
    state.transport_lifecycle.attach_generations(
        generations.clone(),
        generations.current().peer_trust.clone(),
    );
    let current = generations.current();
    let source = GenerationCandidate {
        identity: current.identity.clone(),
        peer_trust: current.peer_trust.clone(),
        own_trust: None,
        identity_required: true,
    };
    let owner = generations.source_owner();
    let claimed = generations.claim_source(&owner).unwrap();
    let epoch = generations
        .activate_from_source(&owner, claimed, source.clone())
        .unwrap();
    let stored = TrustProfileSet {
        revision: 1,
        profiles: vec![StoredTrustProfile {
            profile: old_name,
            kind: TrustProfileKind::PrivateRoot,
            anchors_pem: String::from_utf8(DisposableCa::new("old").root_pem()).unwrap(),
            retiring_anchors_pem: None,
            overlap_until: None,
            enabled: true,
            trust_domain: None,
        }],
    };
    state
        .db
        .set_host_kv(
            trust::KV_TRUST_PROFILES,
            &serde_json::to_string(&stored).unwrap(),
        )
        .await
        .unwrap();
    assert!(trust::refresh(&state, opensesame_time::Utc::now()).await.unwrap());
    let (status, body) = call(&state, "GET", TRUST, operator(&state), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["trust_application"]["reconciled"], true);
    assert_eq!(
        body["trust_application"]["quarantined_stored_profiles"],
        json!(["old-source.test"])
    );

    generations
        .activate_from_source(&owner, epoch, source)
        .unwrap();
    let (status, body) = call(&state, "GET", TRUST, operator(&state), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["trust_application"]["reconciled"], false);
}

#[tokio::test]
async fn empty_trust_reports_reconciled_for_a_live_manager() {
    use opensesame_transport_security::testkit::DisposableCa;
    use opensesame_transport_security::GenerationCandidate;

    let state = support::state().await;
    let server = DisposableCa::new("server")
        .issue_server("localhost")
        .identity();
    let generations = support::generations(server, &DisposableCa::new("clients"));
    state.transport_lifecycle.attach_generations(
        generations.clone(),
        generations.current().peer_trust.clone(),
    );
    assert!(
        !crate::transport_lifecycle::trust::refresh(&state, opensesame_time::Utc::now())
            .await
            .unwrap()
    );
    let (status, body) = call(&state, "GET", TRUST, operator(&state), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["trust_application"]["reconciled"], true);
    assert_eq!(
        body["trust_application"]["quarantined_stored_profiles"],
        json!([])
    );

    let current = generations.current();
    generations
        .activate(GenerationCandidate {
            identity: current.identity.clone(),
            peer_trust: current.peer_trust.clone(),
            own_trust: None,
            identity_required: true,
        })
        .unwrap();
    let (_, body) = call(&state, "GET", TRUST, operator(&state), None).await;
    assert_eq!(body["trust_application"]["reconciled"], false);
    let rotated = generations.current().number;
    assert!(
        !crate::transport_lifecycle::trust::refresh(&state, opensesame_time::Utc::now())
            .await
            .unwrap()
    );
    assert_eq!(generations.current().number, rotated);
    let (_, body) = call(&state, "GET", TRUST, operator(&state), None).await;
    assert_eq!(body["trust_application"]["reconciled"], true);
}

/// The organization-scoped half is unchanged: an admin still reads trust and
/// still reaches revocation of its own certificate by id (absent here, so a
/// 404 from the organization-fenced lookup — not a 403 from the gate).
#[tokio::test]
async fn an_organization_admin_keeps_its_organization_scoped_routes() {
    let state = support::state().await;
    let (status, _) = call(
        &state,
        "GET",
        TRUST,
        admin(&state, OrganizationRole::Admin),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _) = call(
        &state,
        "POST",
        REVOKE,
        admin(&state, OrganizationRole::Admin),
        Some(json!({ "certificate_id": "cert:absent", "reason": "superseded" })),
    )
    .await;
    assert_ne!(status, StatusCode::FORBIDDEN);
    assert_ne!(status, StatusCode::UNAUTHORIZED);
}

fn member(state: &AppState, organization: OrganizationId) -> HeaderMap {
    crate::app_state::test_session_headers(
        state,
        crate::test_principals::P01,
        organization,
        OrganizationRole::Admin,
    )
}

/// Facts and the renewal queue are read within the caller's organization:
/// another organization's target is a `404`, and its parked certificates,
/// attempt counts and failure codes are not listed. The deployment operator
/// still reads both.
#[tokio::test]
async fn facts_and_renewals_stay_inside_the_callers_organization() {
    let state = support::state().await;
    let (owner, other) = (OrganizationId::new(), OrganizationId::new());
    support::seed_authority(&state, &owner).await;
    let issued = crate::transport_lifecycle::issuance::issue_for_transport(
        &state,
        &owner,
        support::listener_request("owner.test"),
        "operator",
    )
    .await
    .expect("issue");
    let certificate = issued.certificate_id;
    let facts = format!("/api/v1/operator/transport/facts/{certificate}");

    let (status, body) = call(&state, "GET", &facts, member(&state, owner), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["target"], certificate.as_str());
    let (status, body) = call(&state, "GET", &facts, member(&state, other), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert!(body.get("history").is_none());
    let (status, _) = call(&state, "GET", &facts, operator(&state), None).await;
    assert_eq!(status, StatusCode::OK);

    let now = opensesame_time::Utc::now();
    let tenant = owner.to_string();
    state.transport_lifecycle.with_scheduler(|scheduler| {
        for _ in 0..crate::transport_lifecycle::renewal::MAX_ATTEMPTS {
            scheduler.claim(&tenant, &certificate, now);
            scheduler.release_failure(&tenant, &certificate, "issuer_unavailable", now, 0.0);
        }
    });
    let renewals = "/api/v1/operator/transport/renewals";
    let (status, body) = call(&state, "GET", renewals, member(&state, other), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["queued"], 0, "{body}");
    assert_eq!(body["parked"], json!([]), "{body}");
    assert!(!body.to_string().contains(&certificate));
    for headers in [member(&state, owner), operator(&state)] {
        let (status, body) = call(&state, "GET", renewals, headers, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["queued"], 1, "{body}");
        assert_eq!(body["parked"][0]["certificate_id"], certificate.as_str());
        assert_eq!(body["parked"][0]["last_code"], "issuer_unavailable");
    }
}
