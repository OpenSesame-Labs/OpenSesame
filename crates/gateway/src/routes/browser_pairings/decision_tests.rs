//! What an operator's approval writes, through the real decision route.
//!
//! Approving a sync pairing makes its person a member of the Host's
//! organization; approving a join pairing (ADR 0136) makes nobody a member
//! of anything — the join routes read no organization role, and one invite
//! is not a seat in the organization.

use crate::routes::shared_sessions::tests::state;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use opensesame_claims::{hash_low_entropy, hash_secret};
use opensesame_connection_broker::config_access::role_policy;
use opensesame_domain::{OrganizationId, PrincipalId};
use opensesame_storage::browser_pairing::NewBrowserPairing;
use serde_json::json;
use tower::ServiceExt;

/// Approve a fresh pairing that asked for `capabilities`; whether it left a role.
async fn approve(capabilities: &str) -> bool {
    let st = Box::pin(state()).await;
    let router = crate::routes::router(st.clone());
    let user_code = "BCDF-GHJK";
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();
    st.db
        .create_browser_pairing(&NewBrowserPairing {
            id: &id,
            device_digest: &format!("device-{id}"),
            user_code_digest: &hash_low_entropy(&st.claim_pepper, "browser-pairing-v1", user_code),
            origin: "https://join.example",
            dpop_jkt: "jkt",
            audience: &st.resource,
            capabilities_json: capabilities,
            now,
        })
        .await
        .unwrap();
    let (org, person) = (OrganizationId::new(), PrincipalId::new());
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/browser-pairings/decision")
        .header("x-opensesame-operator", &st.operator_token)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"user_code": user_code, "decision": "approve",
                "principal_id": person.to_string(), "organization_id": org.to_string()})
            .to_string(),
        ))
        .unwrap();
    let response = router.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    role_policy(st.db.pool(), &org, &person)
        .await
        .unwrap()
        .is_some()
}

#[tokio::test]
async fn approving_a_join_pairing_makes_nobody_a_member() {
    assert!(!approve("[\"host.join\"]").await);
}

#[tokio::test]
async fn approving_a_sync_pairing_still_makes_a_member() {
    assert!(approve("[\"host.sync.read\"]").await);
}

async fn pending_pairing(st: &crate::app_state::AppState, user_code: &str, device: &str) {
    let id = uuid::Uuid::new_v4().to_string();
    st.db
        .create_browser_pairing(&NewBrowserPairing {
            id: &id,
            device_digest: &hash_secret(device),
            user_code_digest: &hash_low_entropy(&st.claim_pepper, "browser-pairing-v1", user_code),
            origin: "https://join.example",
            dpop_jkt: "test-jkt",
            audience: &st.resource,
            capabilities_json: "[\"host.sync.read\"]",
            now: chrono::Utc::now().timestamp(),
        })
        .await
        .unwrap();
}

fn decision_request(
    st: &crate::app_state::AppState,
    code: &str,
    decision: &str,
    org: OrganizationId,
    person: PrincipalId,
) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/api/v1/browser-pairings/decision")
        .header("x-opensesame-operator", &st.operator_token)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"user_code":code,"decision":decision,
            "principal_id":person.to_string(),"organization_id":org.to_string()})
            .to_string(),
        ))
        .unwrap()
}

#[tokio::test]
async fn failed_role_provision_leaves_no_redeemable_approval_and_allows_retry() {
    let st = Box::pin(state()).await;
    let router = crate::routes::router(st.clone());
    let (org, person) = (OrganizationId::new(), PrincipalId::new());
    let (code, device) = ("BCDF-GHJK", "synthetic-test-device");
    pending_pairing(&st, code, device).await;
    sqlx::query("CREATE TRIGGER fail_role BEFORE INSERT ON config_authorization_roles BEGIN SELECT RAISE(ABORT, 'test role outage'); END")
        .execute(st.db.pool()).await.unwrap();

    let failed = router
        .clone()
        .oneshot(decision_request(&st, code, "approve", org, person))
        .await
        .unwrap();
    assert_eq!(failed.status(), StatusCode::SERVICE_UNAVAILABLE);
    let now = chrono::Utc::now().timestamp();
    let digest = hash_low_entropy(&st.claim_pepper, "browser-pairing-v1", code);
    assert!(st
        .db
        .inspect_browser_pairing(&digest, now)
        .await
        .unwrap()
        .is_some());
    assert!(st
        .db
        .consume_browser_pairing(
            &hash_secret(device),
            "https://join.example",
            "test-jkt",
            "synthetic-token-digest",
            now
        )
        .await
        .unwrap()
        .is_none());
    assert!(role_policy(st.db.pool(), &org, &person)
        .await
        .unwrap()
        .is_none());

    sqlx::query("DROP TRIGGER fail_role")
        .execute(st.db.pool())
        .await
        .unwrap();
    let retried = router
        .oneshot(decision_request(&st, code, "approve", org, person))
        .await
        .unwrap();
    assert_eq!(retried.status(), StatusCode::NO_CONTENT);
    assert!(role_policy(st.db.pool(), &org, &person)
        .await
        .unwrap()
        .is_some());
    assert!(st
        .db
        .consume_browser_pairing(
            &hash_secret(device),
            "https://join.example",
            "test-jkt",
            "synthetic-token-digest",
            now
        )
        .await
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn a_denied_or_expired_pairing_cannot_create_a_role() {
    let st = Box::pin(state()).await;
    let router = crate::routes::router(st.clone());
    let (org, person) = (OrganizationId::new(), PrincipalId::new());
    pending_pairing(&st, "BCDF-GHJK", "synthetic-denied-device").await;
    let denied = router
        .clone()
        .oneshot(decision_request(&st, "BCDF-GHJK", "deny", org, person))
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::NO_CONTENT);
    let late = router
        .clone()
        .oneshot(decision_request(&st, "BCDF-GHJK", "approve", org, person))
        .await
        .unwrap();
    assert_eq!(late.status(), StatusCode::UNAUTHORIZED);
    assert!(role_policy(st.db.pool(), &org, &person)
        .await
        .unwrap()
        .is_none());

    pending_pairing(&st, "LMNP-QRST", "synthetic-expired-device").await;
    let digest = hash_low_entropy(&st.claim_pepper, "browser-pairing-v1", "LMNP-QRST");
    sqlx::query("UPDATE browser_pairings SET expires_at=? WHERE user_code_digest=?")
        .bind(chrono::Utc::now().timestamp() - 1)
        .bind(digest)
        .execute(st.db.pool())
        .await
        .unwrap();
    let expired = router
        .oneshot(decision_request(&st, "LMNP-QRST", "approve", org, person))
        .await
        .unwrap();
    assert_eq!(expired.status(), StatusCode::UNAUTHORIZED);
    assert!(role_policy(st.db.pool(), &org, &person)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn competing_approve_and_deny_publish_exactly_one_outcome() {
    let st = Box::pin(state()).await;
    let router = crate::routes::router(st.clone());
    let (org, person) = (OrganizationId::new(), PrincipalId::new());
    pending_pairing(&st, "BCDF-GHJK", "synthetic-race-device").await;
    let approve =
        router
            .clone()
            .oneshot(decision_request(&st, "BCDF-GHJK", "approve", org, person));
    let deny = router.oneshot(decision_request(&st, "BCDF-GHJK", "deny", org, person));
    let (approved, denied) = tokio::join!(approve, deny);
    let (approved, denied) = (approved.unwrap().status(), denied.unwrap().status());
    assert!(matches!(
        (approved, denied),
        (StatusCode::NO_CONTENT, StatusCode::UNAUTHORIZED)
            | (StatusCode::UNAUTHORIZED, StatusCode::NO_CONTENT)
    ));
    assert_eq!(
        role_policy(st.db.pool(), &org, &person)
            .await
            .unwrap()
            .is_some(),
        approved == StatusCode::NO_CONTENT
    );
}

#[tokio::test]
async fn pairing_expired_while_waiting_for_storage_is_not_approved() {
    let st = Box::pin(state()).await;
    let router = crate::routes::router(st.clone());
    let (org, person) = (OrganizationId::new(), PrincipalId::new());
    let code = "BCDF-GHJK";
    pending_pairing(&st, code, "synthetic-expiring-device").await;
    let digest = hash_low_entropy(&st.claim_pepper, "browser-pairing-v1", code);
    sqlx::query("UPDATE browser_pairings SET expires_at=? WHERE user_code_digest=?")
        .bind(chrono::Utc::now().timestamp() + 1)
        .bind(digest)
        .execute(st.db.pool())
        .await
        .unwrap();
    let held = st.db.pool().begin_with("BEGIN IMMEDIATE").await.unwrap();
    let request = decision_request(&st, code, "approve", org, person);
    let pending = tokio::spawn(async move { router.oneshot(request).await.unwrap() });
    tokio::task::yield_now().await;
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    held.commit().await.unwrap();
    let response = pending.await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(role_policy(st.db.pool(), &org, &person)
        .await
        .unwrap()
        .is_none());
}
