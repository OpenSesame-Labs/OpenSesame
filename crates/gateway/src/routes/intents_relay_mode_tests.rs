use super::*;
use opensesame_relay::ExecutionMode;

async fn relay_delegation(
    state: &crate::app_state::AppState,
    org: OrganizationId,
    connection_id: &str,
) -> String {
    let offer = state
        .connection_broker
        .mint_delegation_offer(
            &org,
            OWNER,
            MintOfferRequest {
                items: vec![OfferItemSpec {
                    connection_id: connection_id.into(),
                    actions: Some(vec!["repository.read".into()]),
                    resources: None,
                    expires_in_seconds: None,
                    budgets: None,
                    execution_mode: ExecutionMode::Relay,
                    required: true,
                    dependencies: vec![],
                }],
                ttl_seconds: None,
            },
            &state.claim_pepper,
        )
        .await
        .expect("relay offer");
    let manifest = state
        .connection_broker
        .present_delegation_offer(&offer.claim_token)
        .await
        .expect("present");
    let claimed = state
        .connection_broker
        .claim_delegation_offer(
            ClaimOfferRequest {
                claim_token: offer.claim_token,
                user_code: offer.user_code,
                accepted_item_ids: vec![manifest.items[0].id.clone()],
            },
            GUEST,
            &state.claim_pepper,
        )
        .await
        .expect("claim");
    claimed[0].id.clone()
}

#[tokio::test]
async fn relay_only_delegation_cannot_use_the_broker_invoke_route() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let connection = delegable_github_row(&state, org).await;
    let delegation = relay_delegation(&state, org, &connection).await;
    assert_eq!(
        state
            .connection_broker
            .find_live_delegation_by_id(GUEST, &delegation)
            .await
            .unwrap()
            .unwrap()
            .execution_mode,
        ExecutionMode::Relay
    );
    let headers =
        crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
    let response = create(
        State(state),
        headers,
        Json(invoke_body(&connection, "repository.read")),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_IMPLEMENTED);
    let bytes = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["error"], json!("relay_execution_unavailable"));
}

#[tokio::test]
async fn queued_broker_invoke_rechecks_the_delegation_mode_before_dispatch() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let connection = delegable_github_row(&state, org).await;
    let delegation = delegate_to_guest(&state, org, &connection).await;
    let headers =
        crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
    intents_queue::hold_next_invoke();
    let held = create(
        State(state.clone()),
        headers,
        Json(invoke_body(&connection, "repository.read")),
    )
    .await;
    assert_eq!(held.status(), StatusCode::ACCEPTED);
    sqlx::query("UPDATE connection_delegations SET execution_mode = 'relay' WHERE id = ?")
        .bind(&delegation[0].id)
        .execute(state.connection_broker.pool())
        .await
        .unwrap();
    let response = intents_queue::drain(&state).await;
    assert_eq!(response.status(), StatusCode::NOT_IMPLEMENTED);
    assert_eq!(intents_queue::fixture_work(), 0);
}

#[tokio::test]
async fn completed_broker_retry_does_not_bypass_a_later_relay_mode() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let connection = delegable_github_row(&state, org).await;
    let delegation = delegate_to_guest(&state, org, &connection).await;
    let headers =
        crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
    let request = || {
        let mut body = invoke_body(&connection, "repository.read");
        body.idempotency_key = Some("relay-mode-retry".into());
        body
    };
    let first = create(State(state.clone()), headers.clone(), Json(request())).await;
    assert_eq!(first.status(), StatusCode::OK);
    sqlx::query("UPDATE connection_delegations SET execution_mode = 'relay' WHERE id = ?")
        .bind(&delegation[0].id)
        .execute(state.connection_broker.pool())
        .await
        .unwrap();
    let retry = create(State(state), headers, Json(request())).await;
    assert_eq!(retry.status(), StatusCode::NOT_IMPLEMENTED);
}

#[tokio::test]
async fn invalid_persisted_mode_cannot_default_to_broker_authority() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let connection = delegable_github_row(&state, org).await;
    let delegation = delegate_to_guest(&state, org, &connection).await;
    sqlx::query("UPDATE connection_delegations SET execution_mode = 'unknown' WHERE id = ?")
        .bind(&delegation[0].id)
        .execute(state.connection_broker.pool())
        .await
        .unwrap();
    let headers =
        crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
    let response = create(
        State(state),
        headers,
        Json(invoke_body(&connection, "repository.read")),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}
