//! The real device flow through independently connected Host replicas.
use super::*;
use axum::{
    body::Body,
    http::{header, Request},
};
use opensesame_domain::{OrganizationId, OrganizationRole, PrincipalId};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tower::ServiceExt;

async fn replicas() -> (tempfile::TempDir, AppState, AppState) {
    let directory = tempfile::tempdir().unwrap();
    let url = opensesame_storage::sqlite_file_url(&directory.path().join("host.sqlite"));
    let db_a = opensesame_storage::Db::connect_sqlite(&url).await.unwrap();
    let db_b = opensesame_storage::Db::connect_sqlite(&url).await.unwrap();
    let mut a = crate::app_state::test_demo_state().await;
    a.db = db_a;
    let mut b = a.clone();
    b.db = db_b;
    b.sessions = Arc::new(Mutex::new(HashMap::new()));
    crate::native_authority::bind_configuration(a.db.pool(), &a.resource, &a.claim_pepper)
        .await
        .unwrap();
    crate::native_authority::bind_configuration(b.db.pool(), &b.resource, &b.claim_pepper)
        .await
        .unwrap();
    (directory, a, b)
}

fn operator(st: &AppState) -> axum::http::HeaderMap {
    let mut h = axum::http::HeaderMap::new();
    h.insert("x-opensesame-operator", st.operator_token.parse().unwrap());
    h
}

async fn body(response: Response) -> serde_json::Value {
    serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap()
}

async fn issued(st: &AppState) -> serde_json::Value {
    let response = authorize(
        State(st.clone()),
        Json(DeviceAuthorizeRequest {
            client_id: "opensesame-cli".into(),
            scope: None,
        }),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::OK);
    body(response).await
}

fn request(device: &str) -> DeviceTokenRequest {
    DeviceTokenRequest {
        device_code: device.into(),
        client_id: "opensesame-cli".into(),
        grant_type: "urn:ietf:params:oauth:grant-type:device_code".into(),
    }
}

async fn approved(
    st: &AppState,
    code: &str,
    principal: &str,
    organization: OrganizationId,
    incarnation: &str,
    revision: &str,
) {
    let response = approve(
        State(st.clone()),
        operator(st),
        Json(DeviceApproveRequest {
            user_code: code.into(),
            principal: Some(principal.into()),
            organization_id: Some(organization.to_string()),
            organization_role: Some(OrganizationRole::Member),
            membership_incarnation: Some(incarnation.into()),
            authority_revision: Some(revision.into()),
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
}

async fn withdraw(
    st: &AppState,
    principal: &str,
    organization: OrganizationId,
    incarnation: &str,
    revision: &str,
) -> Response {
    let request = serde_json::from_value(json!({
        "principal_id":principal, "organization_id":organization.to_string(),
        "membership_incarnation":incarnation, "authority_revision":revision,
        "withdrawal_id":uuid::Uuid::new_v4().to_string()
    }))
    .unwrap();
    super::super::session::revoke(State(st.clone()), operator(st), Json(request)).await
}

async fn whoami(st: &AppState, access_token: &str) -> StatusCode {
    let req = Request::builder()
        .uri("/api/v1/whoami")
        .header(header::AUTHORIZATION, format!("Bearer {access_token}"))
        .body(Body::empty())
        .unwrap();
    crate::routes::router(st.clone())
        .oneshot(req)
        .await
        .unwrap()
        .status()
}

#[tokio::test]
async fn device_flow_and_withdrawal_cross_independent_replicas() {
    let (directory, a, b) = replicas().await;
    let organization = OrganizationId::new();
    let principal = PrincipalId::new().to_string();
    let incarnation = uuid::Uuid::new_v4().to_string();
    let revision = uuid::Uuid::new_v4().to_string();
    let codes = issued(&a).await;
    approved(
        &b,
        codes["user_code"].as_str().unwrap(),
        &principal,
        organization,
        &incarnation,
        &revision,
    )
    .await;
    let minted = token(
        State(a.clone()),
        Json(request(codes["device_code"].as_str().unwrap())),
    )
    .await;
    assert_eq!(minted.status(), StatusCode::OK);
    let minted = body(minted).await;
    let access = minted["access_token"].as_str().unwrap();
    assert_eq!(whoami(&a, access).await, StatusCode::OK);
    assert_eq!(whoami(&b, access).await, StatusCode::OK);

    // A fresh process connection has no in-memory session cache. Durable
    // authority must still restore the session before route authentication.
    let url = opensesame_storage::sqlite_file_url(&directory.path().join("host.sqlite"));
    let mut restarted = b.clone();
    restarted.db = opensesame_storage::Db::connect_sqlite(&url).await.unwrap();
    restarted.sessions = Arc::new(Mutex::new(HashMap::new()));
    crate::native_authority::bind_configuration(
        restarted.db.pool(),
        &restarted.resource,
        &restarted.claim_pepper,
    )
    .await
    .unwrap();
    assert_eq!(whoami(&restarted, access).await, StatusCode::OK);

    let response = withdraw(&b, &principal, organization, &incarnation, &revision).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body(response).await["revoked"], 1);
    assert_eq!(whoami(&a, access).await, StatusCode::UNAUTHORIZED);
    assert_eq!(whoami(&b, access).await, StatusCode::UNAUTHORIZED);
    assert_eq!(whoami(&restarted, access).await, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn withdrawal_before_redemption_prevents_a_session_on_another_replica() {
    let (_dir, a, b) = replicas().await;
    let organization = OrganizationId::new();
    let principal = PrincipalId::new().to_string();
    let incarnation = uuid::Uuid::new_v4().to_string();
    let revision = uuid::Uuid::new_v4().to_string();
    let codes = issued(&a).await;
    approved(
        &b,
        codes["user_code"].as_str().unwrap(),
        &principal,
        organization,
        &incarnation,
        &revision,
    )
    .await;
    assert_eq!(
        withdraw(&a, &principal, organization, &incarnation, &revision)
            .await
            .status(),
        StatusCode::OK
    );
    let response = token(
        State(b.clone()),
        Json(request(codes["device_code"].as_str().unwrap())),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM host_native_sessions")
        .fetch_one(b.db.pool())
        .await
        .unwrap();
    assert_eq!(count, 0);
    let stale = approve(
        State(b.clone()),
        operator(&b),
        Json(DeviceApproveRequest {
            user_code: codes["user_code"].as_str().unwrap().into(),
            principal: Some(principal),
            organization_id: Some(organization.to_string()),
            organization_role: Some(OrganizationRole::Member),
            membership_incarnation: Some(incarnation),
            authority_revision: Some(revision),
        }),
    )
    .await;
    assert_eq!(stale.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn simultaneous_redemptions_have_one_winner_across_replicas() {
    let (_dir, a, b) = replicas().await;
    let organization = OrganizationId::new();
    let principal = PrincipalId::new().to_string();
    let incarnation = uuid::Uuid::new_v4().to_string();
    let revision = uuid::Uuid::new_v4().to_string();
    let codes = issued(&a).await;
    approved(
        &b,
        codes["user_code"].as_str().unwrap(),
        &principal,
        organization,
        &incarnation,
        &revision,
    )
    .await;
    let device = codes["device_code"].as_str().unwrap();
    let (one, two) = tokio::join!(
        token(State(a.clone()), Json(request(device))),
        token(State(b.clone()), Json(request(device)))
    );
    let mut statuses = [one.status(), two.status()];
    statuses.sort();
    assert_eq!(statuses, [StatusCode::OK, StatusCode::BAD_REQUEST]);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM host_native_sessions")
        .fetch_one(a.db.pool())
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn a_replica_rejects_different_security_configuration() {
    let (_dir, a, b) = replicas().await;
    assert!(crate::native_authority::bind_configuration(
        b.db.pool(),
        &b.resource,
        "a different claim pepper"
    )
    .await
    .is_err());
    assert!(crate::native_authority::bind_configuration(
        a.db.pool(),
        "https://other.example",
        &a.claim_pepper
    )
    .await
    .is_err());
}

#[tokio::test]
async fn identical_live_human_codes_are_rejected_across_replicas() {
    let (_dir, a, b) = replicas().await;
    let user_code = "BCDF-GHJK";
    let first_digest = hash_secret("dc_first");
    let pending = |digest: &str| crate::app_state::DevicePending {
        user_code_hash: user_code_digest(&a.claim_pepper, digest, user_code),
        client_id: "opensesame-cli".into(),
        scope: DEVICE_SCOPE.into(),
        expires_at: Utc::now() + Duration::minutes(15),
        approved: None,
    };
    assert!(matches!(
        crate::native_device::create(&a, &first_digest, &pending(&first_digest), user_code)
            .await
            .unwrap(),
        crate::native_device::Create::Inserted
    ));
    let second_digest = hash_secret("dc_second");
    assert!(matches!(
        crate::native_device::create(&b, &second_digest, &pending(&second_digest), user_code)
            .await
            .unwrap(),
        crate::native_device::Create::Collision
    ));
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM host_device_codes")
        .fetch_one(b.db.pool())
        .await
        .unwrap();
    assert_eq!(count, 1);
}
