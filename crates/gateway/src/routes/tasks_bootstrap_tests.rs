//! Bootstrap scoping for frozen task authority.

use super::*;

#[path = "tasks_opening_tests.rs"]
mod opening_tests;

#[tokio::test]
async fn non_bootstrap_organization_cannot_freeze_an_unusable_intent() {
    let state = crate::app_state::test_demo_state().await;
    let bootstrap = state.bootstrap.lock().unwrap().clone().unwrap();
    let organization_id = OrganizationId::new();
    let subject = bootstrap.principal.to_string();
    let headers = crate::app_state::test_session_headers(
        &state,
        &subject,
        organization_id,
        opensesame_domain::OrganizationRole::Member,
    );
    let started = start_task(
        State(state.clone()),
        headers.clone(),
        Json(StartTaskBody {
            principal_id: subject,
            organization_id: organization_id.to_string(),
            capabilities: vec![CapabilityDto {
                action: "repository.read".into(),
                resource: "repo:acme/catalog".into(),
            }],
            ttl_seconds: 60,
        }),
    )
    .await
    .unwrap();
    let started = axum::body::to_bytes(started.into_body(), usize::MAX)
        .await
        .unwrap();
    let started: serde_json::Value = serde_json::from_slice(&started).unwrap();

    let response = freeze_intent(
        State(state.clone()),
        headers,
        Json(FreezeIntentBody {
            task_run_id: started["task_run_id"].as_str().unwrap().into(),
            expected_state_version: started["state_version"].as_u64().unwrap(),
            operation: "repository.read".into(),
            resource: "repo:acme/catalog".into(),
            audience: "https://api.example.com".into(),
            arguments: serde_json::json!({}),
            idempotency_key: "foreign-org".into(),
        }),
    )
    .await
    .unwrap_err();

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(state.frozen_intents.lock().unwrap().is_empty());
}

#[tokio::test]
async fn operator_cannot_freeze_for_a_principal_the_grant_does_not_cover() {
    let state = crate::app_state::test_demo_state().await;
    let bootstrap = state.bootstrap.lock().unwrap().clone().unwrap();
    let principal = PrincipalId::new();
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        "x-opensesame-operator",
        state.operator_token.parse().unwrap(),
    );
    let started = start_task(
        State(state.clone()),
        headers.clone(),
        Json(StartTaskBody {
            principal_id: principal.to_string(),
            organization_id: bootstrap.org.to_string(),
            capabilities: vec![CapabilityDto {
                action: "repository.read".into(),
                resource: "repo:acme/catalog".into(),
            }],
            ttl_seconds: 60,
        }),
    )
    .await
    .unwrap();
    let started = axum::body::to_bytes(started.into_body(), usize::MAX)
        .await
        .unwrap();
    let started: serde_json::Value = serde_json::from_slice(&started).unwrap();

    let response = freeze_intent(
        State(state.clone()),
        headers,
        Json(FreezeIntentBody {
            task_run_id: started["task_run_id"].as_str().unwrap().into(),
            expected_state_version: started["state_version"].as_u64().unwrap(),
            operation: "repository.read".into(),
            resource: "repo:acme/catalog".into(),
            audience: "https://api.github.com".into(),
            arguments: serde_json::json!({}),
            idempotency_key: "wrong-beneficiary".into(),
        }),
    )
    .await
    .unwrap_err();

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(state.frozen_intents.lock().unwrap().is_empty());
}
