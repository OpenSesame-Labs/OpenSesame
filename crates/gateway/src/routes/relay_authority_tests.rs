//! The incomplete holder execution path must refuse at the public boundary.

use super::*;
use axum::{body::Body, http::Request};
use tower::ServiceExt;

async fn routed(
    state: &AppState,
    headers: &axum::http::HeaderMap,
    method: &str,
    path: &str,
    body: Value,
) -> Response {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    request.headers_mut().extend(headers.clone());
    crate::routes::router(state.clone())
        .oneshot(request)
        .await
        .unwrap()
}

#[tokio::test]
async fn new_submission_and_legacy_execution_paths_fail_closed_through_router() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let delegation = relay_delegation(&state, org, ExecutionMode::Relay).await;
    let holder =
        crate::app_state::test_session_headers(&state, OWNER, org, OrganizationRole::Member);
    let delegate =
        crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
    let (id, digest) = seed_request(&state, org, &delegation, "pending_approval").await;
    let (approved_id, _) = seed_request(&state, org, &delegation, "approved").await;

    let attempts = [
        (
            "POST",
            "/api/v1/relay/heartbeat".to_string(),
            &holder,
            json!({}),
        ),
        (
            "POST",
            "/api/v1/relay/requests".to_string(),
            &delegate,
            json!({"delegation_id": delegation, "operation":"repository.read", "resource":"repo:acme/catalog"}),
        ),
        (
            "GET",
            "/api/v1/relay/requests/pending".to_string(),
            &holder,
            json!({}),
        ),
        (
            "POST",
            format!("/api/v1/relay/requests/{id}/approve"),
            &holder,
            json!({"request_digest":digest}),
        ),
        (
            "POST",
            format!("/api/v1/relay/requests/{approved_id}/approve"),
            &holder,
            json!({"request_digest":digest}),
        ),
    ];
    for (method, path, headers, body) in attempts {
        let response = routed(&state, headers, method, &path, body).await;
        assert_eq!(response.status(), StatusCode::NOT_IMPLEMENTED, "{path}");
        let body = body_json(response).await;
        assert_eq!(body, json!({"error":"relay_execution_unavailable"}));
        assert!(!body.to_string().contains("relay-sentinel"));
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM relay_requests")
        .fetch_one(state.connection_broker.pool())
        .await
        .unwrap();
    assert_eq!(count, 2, "submission must not create a new request");
    let request_state: String = sqlx::query_scalar("SELECT state FROM relay_requests WHERE id = ?")
        .bind(id)
        .fetch_one(state.connection_broker.pool())
        .await
        .unwrap();
    assert_eq!(request_state, "pending_approval");

    // The feature status is only disclosed to an authenticated caller.
    let no_session = routed(
        &state,
        &axum::http::HeaderMap::new(),
        "GET",
        "/api/v1/relay/requests/pending",
        json!({}),
    )
    .await;
    assert_eq!(no_session.status(), StatusCode::UNAUTHORIZED);
    let no_session_heartbeat = routed(
        &state,
        &axum::http::HeaderMap::new(),
        "POST",
        "/api/v1/relay/heartbeat",
        json!({}),
    )
    .await;
    assert_eq!(no_session_heartbeat.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn previously_approved_work_is_not_redisclosed_and_revoked_reports_fail() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let delegation = relay_delegation(&state, org, ExecutionMode::Relay).await;
    let holder =
        crate::app_state::test_session_headers(&state, OWNER, org, OrganizationRole::Member);
    let (id, digest) = seed_request(&state, org, &delegation, "approved").await;
    state
        .connection_broker
        .revoke_delegation(&org, OWNER, &delegation)
        .await
        .unwrap();
    let inbox = pending(State(state.clone()), holder.clone()).await;
    assert_eq!(inbox.status(), StatusCode::NOT_IMPLEMENTED);
    let reported = result(
        State(state),
        holder,
        Path(id),
        Json(ResultRequest {
            executed_digest: digest,
            outcome: "succeeded".into(),
            safe_summary: None,
        }),
    )
    .await;
    assert!(!reported.status().is_success());
}
