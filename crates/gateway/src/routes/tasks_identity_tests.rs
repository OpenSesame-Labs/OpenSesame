//! Identity task start and frozen-intent mismatch refusal tests.

use super::tests::intent;
use super::{invoke_task, start_task, CapabilityDto, InvokeTaskBody, StartTaskBody};
use axum::{extract::State, http::StatusCode, Json};
use opensesame_domain::{OrganizationId, PrincipalId};

#[tokio::test]
async fn identity_principal_id_starts_a_task_for_its_session() {
    let state = crate::app_state::test_demo_state().await;
    let bootstrap = state.bootstrap.lock().unwrap().clone().unwrap();
    let identity_principal = format!("prn_{}", bootstrap.principal.as_uuid());
    let headers = crate::app_state::test_session_headers(
        &state,
        &identity_principal,
        bootstrap.org,
        opensesame_domain::OrganizationRole::Member,
    );

    let response = start_task(
        State(state),
        headers,
        Json(StartTaskBody {
            principal_id: identity_principal,
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
    assert_eq!(response.status(), StatusCode::CREATED);
}

#[tokio::test]
async fn invoking_a_legacy_mismatched_intent_does_not_consume_it() {
    let state = crate::app_state::test_demo_state().await;
    let bootstrap = state.bootstrap.lock().unwrap().clone().unwrap();
    let organization_id = OrganizationId::new();
    let frozen = intent(bootstrap.principal, organization_id, 5);
    state
        .frozen_intents
        .lock()
        .unwrap()
        .insert(frozen.intent_digest.clone(), frozen.clone());
    let headers = crate::app_state::test_session_headers(
        &state,
        &bootstrap.principal.to_string(),
        organization_id,
        opensesame_domain::OrganizationRole::Member,
    );

    let response = invoke_task(
        State(state.clone()),
        headers,
        Json(InvokeTaskBody {
            intent_digest: frozen.intent_digest.clone(),
        }),
    )
    .await
    .unwrap_err();

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(state
        .frozen_intents
        .lock()
        .unwrap()
        .contains_key(&frozen.intent_digest));
}

#[tokio::test]
async fn invoking_a_same_org_wrong_beneficiary_intent_does_not_consume_it() {
    let state = crate::app_state::test_demo_state().await;
    let bootstrap = state.bootstrap.lock().unwrap().clone().unwrap();
    let mut frozen = intent(PrincipalId::new(), bootstrap.org, 5);
    frozen.project_id = Some(bootstrap.project);
    frozen.actor_id = bootstrap.actor;
    frozen.connection_id = Some(bootstrap.connection);
    state
        .frozen_intents
        .lock()
        .unwrap()
        .insert(frozen.intent_digest.clone(), frozen.clone());
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        "x-opensesame-operator",
        state.operator_token.parse().unwrap(),
    );

    let response = invoke_task(
        State(state.clone()),
        headers,
        Json(InvokeTaskBody {
            intent_digest: frozen.intent_digest.clone(),
        }),
    )
    .await
    .unwrap_err();

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(state
        .frozen_intents
        .lock()
        .unwrap()
        .contains_key(&frozen.intent_digest));
}
