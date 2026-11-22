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

async fn routed_invalid_json(
    state: &AppState,
    headers: &axum::http::HeaderMap,
    path: &str,
) -> Response {
    let mut request = Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json")
        .body(Body::from("{"))
        .unwrap();
    request.headers_mut().extend(headers.clone());
    crate::routes::router(state.clone())
        .oneshot(request)
        .await
        .unwrap()
}

#[tokio::test]
async fn relay_body_routes_authenticate_without_parsing_json() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let holder =
        crate::app_state::test_session_headers(&state, OWNER, org, OrganizationRole::Member);
    for (path, expected) in [
        ("/api/v1/relay/requests", StatusCode::NOT_IMPLEMENTED),
        (
            "/api/v1/relay/requests/arbitrary/approve",
            StatusCode::NOT_IMPLEMENTED,
        ),
        (
            "/api/v1/relay/requests/arbitrary/result",
            StatusCode::NOT_IMPLEMENTED,
        ),
        (
            "/api/v1/relay/requests/arbitrary/deny",
            StatusCode::NOT_FOUND,
        ),
    ] {
        let anonymous = routed_invalid_json(&state, &axum::http::HeaderMap::new(), path).await;
        assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED, "{path}");
        let authenticated = routed_invalid_json(&state, &holder, path).await;
        assert_eq!(authenticated.status(), expected, "{path}");
    }
}

#[tokio::test]
async fn authorized_denial_ignores_an_unparseable_body() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let delegation = relay_delegation(&state, org, ExecutionMode::Relay).await;
    let holder =
        crate::app_state::test_session_headers(&state, OWNER, org, OrganizationRole::Member);
    let (id, _) = seed_request(&state, org, &delegation, "pending_approval").await;
    let response = routed_invalid_json(
        &state,
        &holder,
        &format!("/api/v1/relay/requests/{id}/deny"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let status: String = sqlx::query_scalar("SELECT state FROM relay_requests WHERE id = ?")
        .bind(id)
        .fetch_one(state.connection_broker.pool())
        .await
        .unwrap();
    assert_eq!(status, "denied");
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
        (
            "POST",
            format!("/api/v1/relay/requests/{approved_id}/result"),
            &holder,
            json!({"executed_digest":digest,"outcome":"succeeded"}),
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
    let no_session_result = routed(
        &state,
        &axum::http::HeaderMap::new(),
        "POST",
        &format!("/api/v1/relay/requests/{approved_id}/result"),
        json!({"executed_digest":digest,"outcome":"succeeded"}),
    )
    .await;
    assert_eq!(no_session_result.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn previously_approved_work_is_not_redisclosed_and_revoked_reports_fail() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let delegation = relay_delegation(&state, org, ExecutionMode::Relay).await;
    let holder =
        crate::app_state::test_session_headers(&state, OWNER, org, OrganizationRole::Member);
    let (id, _) = seed_request(&state, org, &delegation, "approved").await;
    state
        .connection_broker
        .revoke_delegation(&org, OWNER, &delegation)
        .await
        .unwrap();
    let inbox = pending(State(state.clone()), holder.clone()).await;
    assert_eq!(inbox.status(), StatusCode::NOT_IMPLEMENTED);
    let reported = result(State(state), holder, Path(id)).await;
    assert_eq!(reported.status(), StatusCode::NOT_IMPLEMENTED);
}
