//! Exercise the real task API across freeze and broker execution.

use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use tower::ServiceExt;

async fn post(app: &Router, token: &str, path: &str, body: Value) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer opaque-session:{token}"))
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn frozen_task_executes_through_the_real_router() {
    let state = crate::app_state::test_demo_state().await;
    let bootstrap = {
        let mut guard = state.bootstrap.lock().unwrap();
        let bootstrap = guard.as_mut().unwrap();
        // The test fixture's default grant requires MFA that its mock
        // session cannot establish. This test exercises task binding instead.
        bootstrap.grant.constraints.required_assurance = None;
        bootstrap.grant.constraints.authentication_max_age_seconds = None;
        bootstrap.clone()
    };
    let headers = crate::app_state::test_session_headers(
        &state,
        &bootstrap.principal.to_string(),
        bootstrap.org,
        opensesame_domain::OrganizationRole::Member,
    );
    let authorization = headers.get("authorization").unwrap().to_str().unwrap();
    let token = authorization
        .strip_prefix("Bearer opaque-session:")
        .unwrap();
    let app = crate::routes::router(state);
    let (status, started) = post(
        &app,
        token,
        "/api/v1/tasks",
        json!({
            "principal_id": bootstrap.principal.to_string(),
            "organization_id": bootstrap.org.to_string(),
            "capabilities": [{"action":"repository.read", "resource":"repo:acme/catalog"}],
            "ttl_seconds": 60
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{started}");
    let (status, frozen) = post(
        &app,
        token,
        "/api/v1/tasks/intents",
        json!({
            "task_run_id": started["task_run_id"],
            "expected_state_version": started["state_version"],
            "operation": "repository.read",
            "resource": "repo:acme/catalog",
            "audience": "https://api.github.com",
            "arguments": {},
            "idempotency_key": "task-roundtrip"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{frozen}");
    let (status, receipt) = post(
        &app,
        token,
        "/api/v1/tasks/invoke",
        json!({
            "intent_digest": frozen["intent_digest"]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{receipt}");
    assert_eq!(receipt["outcome"], "succeeded");
    let receipt_run = opensesame_domain::TaskRunId::parse(
        receipt["task_run_id"].as_str().expect("receipt task id"),
    )
    .unwrap();
    let started_run = opensesame_domain::TaskRunId::parse(
        started["task_run_id"].as_str().expect("started task id"),
    )
    .unwrap();
    assert_eq!(receipt_run, started_run);
}
