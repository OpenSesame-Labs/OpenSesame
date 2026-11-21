//! The frozen-intent opening is limited to the task's invocation caller.

use super::super::*;
use axum::{
    body::Body,
    http::{HeaderMap, HeaderValue},
    routing::post,
    Router,
};
use opensesame_domain::{InvocationReceipt, OrganizationRole};
use std::{
    io::{self, Write},
    sync::{Arc, Mutex},
};
use tower::ServiceExt;
use tower_http::trace::TraceLayer;

struct Capture(Arc<Mutex<Vec<u8>>>);

impl Write for Capture {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

async fn body(response: Response) -> Value {
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

async fn recover(state: &AppState, headers: &HeaderMap, value: &Value) -> Response {
    let router = Router::new()
        .route(
            "/api/v1/tasks/intent-opening",
            post(crate::routes::tasks_opening::recover),
        )
        .with_state(state.clone())
        .layer(TraceLayer::new_for_http());
    let mut request = axum::http::Request::builder()
        .method("POST")
        .uri("/api/v1/tasks/intent-opening")
        .header("content-type", "application/json");
    for (name, value) in headers {
        request = request.header(name, value);
    }
    router
        .oneshot(request.body(Body::from(value.to_string())).unwrap())
        .await
        .unwrap()
}

async fn routed_post(state: &AppState, headers: &HeaderMap, uri: &str, value: &Value) -> Response {
    let mut request = axum::http::Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json");
    for (name, value) in headers {
        request = request.header(name, value);
    }
    crate::routes::router(state.clone())
        .oneshot(request.body(Body::from(value.to_string())).unwrap())
        .await
        .unwrap()
}

#[tokio::test]
async fn oversized_frozen_intent_is_refused_before_it_can_be_issued() {
    let state = crate::app_state::test_demo_state().await;
    let boot = state.bootstrap.lock().unwrap().clone().unwrap();
    let subject = boot.principal.to_string();
    let headers = crate::app_state::test_session_headers(
        &state,
        &subject,
        boot.org,
        OrganizationRole::Member,
    );
    let task = body(
        start_task(
            State(state.clone()),
            headers.clone(),
            Json(StartTaskBody {
                principal_id: subject,
                organization_id: boot.org.to_string(),
                capabilities: vec![CapabilityDto {
                    action: "repository.read".into(),
                    resource: "repo:acme/catalog".into(),
                }],
                ttl_seconds: 60,
            }),
        )
        .await
        .unwrap(),
    )
    .await;
    let refused = freeze_intent(
        State(state.clone()),
        headers,
        Json(FreezeIntentBody {
            task_run_id: task["task_run_id"].as_str().unwrap().into(),
            expected_state_version: task["state_version"].as_u64().unwrap(),
            operation: "repository.read".into(),
            resource: "repo:acme/catalog".into(),
            audience: "https://api.github.com".into(),
            arguments: json!("x".repeat(crate::routes::tasks_opening::MAX_RECOVERY_BODY_BYTES)),
            idempotency_key: "oversized".into(),
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(refused.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert!(state.frozen_intents.lock().unwrap().is_empty());
}

#[tokio::test]
async fn routed_agent_invocation_gets_its_opening_but_cannot_use_recovery() {
    let mut state = crate::app_state::test_demo_state().await;
    let boot = state.bootstrap.lock().unwrap().clone().unwrap();
    let subject = boot.principal.to_string();
    Arc::get_mut(&mut state.broker)
        .unwrap()
        .policy
        .assurance
        .insert(subject.clone(), "mfa".into());
    let session = crate::app_state::test_session_headers(
        &state,
        &subject,
        boot.org,
        OrganizationRole::Member,
    );
    let task = body(
        start_task(
            State(state.clone()),
            session,
            Json(StartTaskBody {
                principal_id: subject.clone(),
                organization_id: boot.org.to_string(),
                capabilities: vec![CapabilityDto {
                    action: "repository.read".into(),
                    resource: "repo:acme/catalog".into(),
                }],
                ttl_seconds: 60,
            }),
        )
        .await
        .unwrap(),
    )
    .await;

    let client = uuid::Uuid::new_v4().to_string();
    let audience = "urn:opensesame:agent:mcp-host";
    let mut operator = HeaderMap::new();
    operator.insert(
        "x-opensesame-operator",
        HeaderValue::from_str(&state.operator_token).unwrap(),
    );
    let launch_response = routed_post(
        &state,
        &operator,
        "/api/v1/agent-launches",
        &json!({
            "principal_id": subject,
            "organization_id": boot.org,
            "client_id": client,
            "audience": audience,
            "capabilities": ["host.tasks.invoke"],
        }),
    )
    .await;
    assert_eq!(launch_response.status(), StatusCode::CREATED);
    let launch = body(launch_response).await;
    let token_response = routed_post(
        &state,
        &HeaderMap::new(),
        "/api/v1/agent-launches/token",
        &json!({
            "launch_handle": launch["launch_handle"],
            "client_id": client,
            "audience": audience,
        }),
    )
    .await;
    assert_eq!(token_response.status(), StatusCode::OK);
    let token = body(token_response).await;
    let mut agent = HeaderMap::new();
    agent.insert(
        "authorization",
        HeaderValue::from_str(&format!(
            "Bearer {}",
            token["access_token"].as_str().unwrap()
        ))
        .unwrap(),
    );
    agent.insert(
        "x-opensesame-agent-client",
        HeaderValue::from_str(&client).unwrap(),
    );
    agent.insert(
        "x-opensesame-agent-audience",
        HeaderValue::from_static(audience),
    );

    let frozen_response = routed_post(
        &state,
        &agent,
        "/api/v1/tasks/intents",
        &json!({
            "task_run_id": task["task_run_id"],
            "expected_state_version": task["state_version"],
            "operation": "repository.read",
            "resource": "repo:acme/catalog",
            "audience": "https://api.github.com",
            "arguments": {},
            "idempotency_key": "routed-agent-opening",
        }),
    )
    .await;
    assert_eq!(frozen_response.status(), StatusCode::CREATED);
    let frozen = body(frozen_response).await;
    assert!(frozen["intent"]["nonce"].as_str().is_some());
    assert!(frozen.get("opening").is_none());

    let invoked_response = routed_post(
        &state,
        &agent,
        "/api/v1/tasks/invoke",
        &json!({"intent_digest": frozen["intent_digest"]}),
    )
    .await;
    assert_eq!(invoked_response.status(), StatusCode::OK);
    assert_eq!(invoked_response.headers()["cache-control"], "no-store");
    let invoked = body(invoked_response).await;
    let opening = invoked["intent_opening"]["opening"].as_str().unwrap();
    assert_eq!(invoked["intent_opening"]["intent"], frozen["intent"]);

    let denied = routed_post(
        &state,
        &agent,
        "/api/v1/tasks/intent-opening",
        &json!({
            "intent": frozen["intent"],
            "intent_digest": frozen["intent_digest"],
        }),
    )
    .await;
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    assert!(!body(denied).await.to_string().contains(opening));
}

#[cfg(test)]
#[path = "tasks_opening_owner_tests.rs"]
mod owner_tests;
