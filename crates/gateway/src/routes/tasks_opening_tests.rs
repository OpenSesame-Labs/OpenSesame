//! The frozen-intent opening is limited to the task's invocation caller.

use super::super::*;
use axum::{body::Body, http::HeaderMap, routing::post, Router};
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
async fn frozen_invocation_discloses_opening_only_to_its_owner() {
    let mut state = crate::app_state::test_demo_state().await;
    let boot = state.bootstrap.lock().unwrap().clone().unwrap();
    let subject = boot.principal.to_string();
    Arc::get_mut(&mut state.broker)
        .unwrap()
        .policy
        .assurance
        .insert(subject.clone(), "mfa".into());
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
    let task_id = task["task_run_id"].as_str().unwrap();
    let frozen_response = freeze_intent(
        State(state.clone()),
        headers.clone(),
        Json(FreezeIntentBody {
            task_run_id: task_id.into(),
            expected_state_version: task["state_version"].as_u64().unwrap(),
            operation: "repository.read".into(),
            resource: "repo:acme/catalog".into(),
            audience: "https://api.github.com".into(),
            arguments: json!({}),
            idempotency_key: "task-opening".into(),
        }),
    )
    .await
    .unwrap();
    assert_eq!(frozen_response.headers()["cache-control"], "no-store");
    let frozen = body(frozen_response).await;
    let digest = frozen["intent_digest"].as_str().unwrap();
    let saved_intent: FrozenIntentV2 = serde_json::from_value(frozen["intent"].clone()).unwrap();
    assert_eq!(saved_intent.compute_digest().unwrap(), digest);
    let recovery = json!({"intent": frozen["intent"].clone(), "intent_digest": digest});
    let stranger = crate::app_state::test_session_headers(
        &state,
        &PrincipalId::new().to_string(),
        boot.org,
        OrganizationRole::Member,
    );
    let denied = invoke_task(
        State(state.clone()),
        stranger.clone(),
        Json(InvokeTaskBody {
            intent_digest: digest.into(),
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(denied.status(), StatusCode::NOT_FOUND);
    assert!(body(denied).await.get("intent_opening").is_none());

    let response = invoke_task(
        State(state.clone()),
        headers.clone(),
        Json(InvokeTaskBody {
            intent_digest: digest.into(),
        }),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let response = body(response).await;
    let receipt: InvocationReceipt = serde_json::from_value(response.clone()).unwrap();
    state.receipt_verifier.verify(&receipt).unwrap();
    let opening = response["intent_opening"]["opening"].as_str().unwrap();
    assert_eq!(
        receipt.id.to_string(),
        frozen["receipt_id"].as_str().unwrap()
    );
    let intent: FrozenIntentV2 =
        serde_json::from_value(response["intent_opening"]["intent"].clone()).unwrap();
    assert_eq!(intent.compute_digest().unwrap(), digest);
    assert!(receipt.verifies_intent_opening(opening, digest));
    assert!(!serde_json::to_string(&receipt).unwrap().contains(opening));

    // The original invocation response can be lost: the freeze response
    // already contains the receipt handle and all bytes needed to re-prove
    // the original frozen intent. Recovery returns only the opening.
    let logs = Arc::new(Mutex::new(Vec::new()));
    let log_buffer = logs.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_ansi(false)
        .without_time()
        .with_max_level(tracing::Level::TRACE)
        .with_writer(move || Capture(log_buffer.clone()))
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);
    let recovered = recover(&state, &headers, &recovery).await;
    assert_eq!(recovered.status(), StatusCode::OK);
    assert_eq!(recovered.headers()["cache-control"], "no-store");
    assert_eq!(body(recovered).await, json!({"opening": opening}));
    let new_session = crate::app_state::test_session_headers(
        &state,
        &subject,
        boot.org,
        OrganizationRole::Member,
    );
    let mut operator = HeaderMap::new();
    operator.insert(
        "x-opensesame-operator",
        state.operator_token.parse().unwrap(),
    );
    for authorized in [&new_session, &operator] {
        let recovered = recover(&state, authorized, &recovery).await;
        assert_eq!(recovered.status(), StatusCode::OK);
        assert_eq!(body(recovered).await, json!({"opening": opening}));
    }

    let fetched = crate::routes::receipts::get(
        State(state.clone()),
        headers.clone(),
        axum::extract::Path(frozen["receipt_id"].as_str().unwrap().into()),
    )
    .await;
    assert_eq!(fetched.status(), StatusCode::OK);
    let fetched = body(fetched).await;
    assert!(!fetched.to_string().contains(opening));
    let fetched: InvocationReceipt = serde_json::from_value(fetched).unwrap();
    state.receipt_verifier.verify(&fetched).unwrap();
    assert!(fetched.verifies_intent_opening(opening, digest));

    let mut changed = recovery.clone();
    changed["intent"]["nonce"] = json!("changed");
    let changed_intent: FrozenIntentV2 = serde_json::from_value(changed["intent"].clone()).unwrap();
    changed["intent_digest"] = json!(changed_intent.compute_digest().unwrap());
    let refused = recover(&state, &headers, &changed).await;
    assert_eq!(refused.status(), StatusCode::NOT_FOUND);
    let refusal_body = body(refused).await;
    let mut extra_field = recovery.clone();
    extra_field["intent"]["unexpected"] = json!("ignored-field");
    let refused = recover(&state, &headers, &extra_field).await;
    assert_eq!(refused.status(), StatusCode::NOT_FOUND);
    assert_eq!(body(refused).await, refusal_body);
    let foreign = recover(&state, &stranger, &recovery).await;
    assert_eq!(foreign.status(), StatusCode::NOT_FOUND);
    assert_eq!(body(foreign).await, refusal_body);
    for candidate in [&recovery, &changed] {
        let unauthenticated = recover(&state, &HeaderMap::new(), candidate).await;
        assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);
        assert!(!body(unauthenticated).await.to_string().contains(opening));
    }

    let original_grant = state
        .bootstrap
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .grant
        .clone();
    state
        .bootstrap
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .grant
        .version += 1;
    let changed_authority = recover(&state, &headers, &recovery).await;
    assert_eq!(changed_authority.status(), StatusCode::NOT_FOUND);
    assert_eq!(body(changed_authority).await, refusal_body);
    state.bootstrap.lock().unwrap().as_mut().unwrap().grant = original_grant;

    sqlx::query("DELETE FROM receipts WHERE id = ?")
        .bind(receipt.id.to_string())
        .execute(state.db.pool())
        .await
        .unwrap();
    let mut tampered = receipt.clone();
    tampered.operation = "tampered".into();
    state.db.insert_receipt(&tampered).await.unwrap();
    let refused = recover(&state, &headers, &recovery).await;
    assert_eq!(refused.status(), StatusCode::NOT_FOUND);
    assert_eq!(body(refused).await, refusal_body);
    sqlx::query("DELETE FROM receipts WHERE id = ?")
        .bind(receipt.id.to_string())
        .execute(state.db.pool())
        .await
        .unwrap();
    state.db.insert_receipt(&receipt).await.unwrap();

    let events: Vec<String> = sqlx::query_scalar(
        "SELECT payload_json FROM outbox_events UNION ALL SELECT COALESCE(detail, '') FROM connection_events",
    )
    .fetch_all(state.db.pool())
    .await
    .unwrap();
    for event in events {
        assert!(!event.contains(opening));
    }
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT body_json FROM receipts UNION ALL SELECT body_json FROM intents UNION ALL SELECT body_json FROM invocations",
    )
    .fetch_all(state.db.pool())
    .await
    .unwrap();
    for row in rows {
        assert!(!row.contains(opening));
    }
    let trace = String::from_utf8(logs.lock().unwrap().clone()).unwrap();
    assert!(!trace.is_empty());
    assert!(!trace.contains(opening));
    assert!(!trace.contains(digest));

    Arc::get_mut(&mut state.broker).unwrap().signer =
        opensesame_audit::ReceiptSigner::from_seed(&[42; 32]);
    let retired = recover(&state, &headers, &recovery).await;
    assert_eq!(retired.status(), StatusCode::NOT_FOUND);
    assert_eq!(body(retired).await, refusal_body);
    state.receipt_verifier.verify(&receipt).unwrap();
    assert!(receipt.verifies_intent_opening(opening, digest));

    let list = list_tasks(State(state.clone()), headers.clone())
        .await
        .unwrap();
    assert!(!body(list).await.to_string().contains(opening));
    let detail = get_task(State(state), headers, axum::extract::Path(task_id.into()))
        .await
        .unwrap();
    assert!(!body(detail).await.to_string().contains(opening));
}
