use super::*;

pub(super) async fn delegate_to_guest_with_budget(
    state: &crate::app_state::AppState,
    org: OrganizationId,
    connection_id: &str,
    budget: Option<i64>,
) -> Vec<opensesame_connection_broker::delegation::DelegationView> {
    let minted = state
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
                    budgets: budget.map(|limit| {
                        [(
                            opensesame_connection_broker::delegation::BUDGET_INVOCATIONS.into(),
                            limit,
                        )]
                        .into_iter()
                        .collect()
                    }),
                    execution_mode: opensesame_relay::ExecutionMode::Broker,
                    required: true,
                    dependencies: vec![],
                }],
                ttl_seconds: None,
            },
            &state.claim_pepper,
        )
        .await
        .expect("mint");
    let manifest = state
        .connection_broker
        .present_delegation_offer(&minted.claim_token)
        .await
        .expect("present");
    state
        .connection_broker
        .claim_delegation_offer(
            ClaimOfferRequest {
                claim_token: minted.claim_token.clone(),
                user_code: minted.user_code.clone(),
                accepted_item_ids: vec![manifest.items[0].id.clone()],
            },
            GUEST,
            &state.claim_pepper,
        )
        .await
        .expect("claim")
}

fn keyed_body(connection_id: &str, key: &str) -> InvokeBody {
    let mut body = invoke_body(connection_id, "repository.read");
    body.idempotency_key = Some(key.into());
    body
}

async fn fixture() -> (crate::app_state::AppState, OrganizationId, String, String) {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let connection = delegable_github_row(&state, org).await;
    let delegation = delegate_to_guest_with_budget(&state, org, &connection, Some(1)).await;
    (state, org, connection, delegation[0].id.clone())
}

async fn remaining(state: &crate::app_state::AppState, delegation: &str) -> i64 {
    let raw: String =
        sqlx::query_scalar("SELECT budget_remaining FROM connection_delegations WHERE id = ?")
            .bind(delegation)
            .fetch_one(state.connection_broker.pool())
            .await
            .unwrap();
    serde_json::from_str::<Value>(&raw).unwrap()["invocations"]
        .as_i64()
        .unwrap()
}

async fn receipt_id(response: Response) -> String {
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    serde_json::from_slice::<Value>(&bytes).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[tokio::test]
async fn completed_retry_reuses_receipt_without_spending_the_last_unit_again() {
    let (state, org, connection, delegation) = fixture().await;
    let headers =
        crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
    let first = create(
        State(state.clone()),
        headers.clone(),
        Json(keyed_body(&connection, "retry")),
    )
    .await;
    let first_id = receipt_id(first).await;
    assert_eq!(remaining(&state, &delegation).await, 0);

    let retry = create(
        State(state.clone()),
        headers.clone(),
        Json(keyed_body(&connection, "retry")),
    )
    .await;
    assert_eq!(receipt_id(retry).await, first_id);
    assert_eq!(remaining(&state, &delegation).await, 0);

    let mut conflict = keyed_body(&connection, "retry");
    conflict.parameters = Some(json!({"different": true}));
    let conflict = create(State(state.clone()), headers.clone(), Json(conflict)).await;
    assert!(matches!(
        conflict.status(),
        StatusCode::FORBIDDEN | StatusCode::CONFLICT
    ));
    let second = create(
        State(state.clone()),
        headers.clone(),
        Json(keyed_body(&connection, "new")),
    )
    .await;
    assert_eq!(second.status(), StatusCode::FORBIDDEN);
    assert_eq!(remaining(&state, &delegation).await, 0);

    state
        .connection_broker
        .revoke_delegation(&org, OWNER, &delegation)
        .await
        .unwrap();
    let revoked_retry = create(
        State(state),
        headers,
        Json(keyed_body(&connection, "retry")),
    )
    .await;
    assert_eq!(revoked_retry.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn concurrent_retries_cannot_spend_twice_or_bypass_an_inflight_claim() {
    let (state, org, connection, delegation) = fixture().await;
    let headers =
        crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
    let (first, second) = tokio::join!(
        create(
            State(state.clone()),
            headers.clone(),
            Json(keyed_body(&connection, "concurrent"))
        ),
        create(
            State(state.clone()),
            headers,
            Json(keyed_body(&connection, "concurrent"))
        ),
    );
    let statuses = [first.status(), second.status()];
    assert!(statuses.contains(&StatusCode::OK));
    assert!(statuses.iter().all(|status| matches!(
        *status,
        StatusCode::OK | StatusCode::CONFLICT | StatusCode::FORBIDDEN
    )));
    assert_eq!(remaining(&state, &delegation).await, 0);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM invocation_budget_claims WHERE organization_id = ? AND idempotency_key = ?")
        .bind(org.to_string())
        .bind("concurrent")
        .fetch_one(state.db.pool()).await.unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn revoked_queued_work_refunds_only_its_own_delegation_claim() {
    let (state, org, connection, delegation) = fixture().await;
    let headers =
        crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
    super::super::intents_queue::hold_next_invoke();
    let queued = create(
        State(state.clone()),
        headers,
        Json(keyed_body(&connection, "queued")),
    )
    .await;
    assert_eq!(queued.status(), StatusCode::ACCEPTED);
    assert_eq!(remaining(&state, &delegation).await, 0);
    state
        .connection_broker
        .revoke_delegation(&org, OWNER, &delegation)
        .await
        .unwrap();
    assert_eq!(
        super::super::intents_queue::drain(&state).await.status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(remaining(&state, &delegation).await, 1);
}

#[tokio::test]
async fn a_conflicting_request_cannot_use_an_inflight_claim() {
    let (state, org, connection, delegation) = fixture().await;
    let headers =
        crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
    super::super::intents_queue::hold_next_invoke();
    let queued = create(
        State(state.clone()),
        headers.clone(),
        Json(keyed_body(&connection, "shared-key")),
    )
    .await;
    assert_eq!(queued.status(), StatusCode::ACCEPTED);
    let mut conflict = keyed_body(&connection, "shared-key");
    conflict.parameters = Some(json!({"changed": true}));
    let conflict = create(State(state.clone()), headers, Json(conflict)).await;
    assert_eq!(conflict.status(), StatusCode::CONFLICT);
    assert_eq!(remaining(&state, &delegation).await, 0);
    assert_eq!(
        super::super::intents_queue::drain(&state).await.status(),
        StatusCode::OK
    );
    assert_eq!(remaining(&state, &delegation).await, 0);
}

#[tokio::test]
async fn omitted_key_is_the_same_for_the_budget_and_the_persisted_intent() {
    let (state, org, connection, _) = fixture().await;
    let headers =
        crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
    let response = create(
        State(state.clone()),
        headers,
        Json(invoke_body(&connection, "repository.read")),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM intents i JOIN invocation_budget_claims c \
         ON c.organization_id = i.organization_id AND c.idempotency_key = i.idempotency_key",
    )
    .fetch_one(state.db.pool())
    .await
    .unwrap();
    assert_eq!(count, 1);
    let fingerprint: String =
        sqlx::query_scalar("SELECT fingerprint FROM invocation_budget_claims")
            .fetch_one(state.db.pool())
            .await
            .unwrap();
    assert!(fingerprint.starts_with("hmac-sha256:"));
}

#[tokio::test]
async fn only_an_authorized_matching_replay_settles_an_interrupted_authority_hold() {
    let (state, org, connection, delegation) = fixture().await;
    let headers =
        crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
    let first = create(
        State(state.clone()),
        headers.clone(),
        Json(keyed_body(&connection, "recover")),
    )
    .await;
    assert_eq!(first.status(), StatusCode::OK);
    let claim_id: String = sqlx::query_scalar(
        "SELECT claim_id FROM invocation_budget_claims WHERE organization_id = ? AND idempotency_key = ?",
    )
    .bind(org.to_string())
    .bind("recover")
    .fetch_one(state.db.pool())
    .await
    .unwrap();
    let grant_id: String =
        sqlx::query_scalar("SELECT grant_id FROM connection_delegations WHERE id = ?")
            .bind(&delegation)
            .fetch_one(state.db.pool())
            .await
            .unwrap();
    let org_id = org.to_string();
    sqlx::query("INSERT INTO authority_budgets (organization_id, scope_kind, scope_id, unit, window_key, authorized_capacity, outstanding_reservations, revision, updated_at) VALUES (?, 'root_grant', ?, 'api_calls', 'window', 1, 1, 1, '2020')")
        .bind(&org_id).bind(&grant_id).execute(state.db.pool()).await.unwrap();
    sqlx::query("INSERT INTO authority_budget_reservations (id, organization_id, scope_kind, scope_id, unit, window_key, grant_id, quantity, state, idempotency_key, operational_generation, created_at, updated_at) VALUES ('recovery-hold', ?, 'root_grant', ?, 'api_calls', 'window', ?, 1, 'reserved', ?, 1, '2020', '2020')")
        .bind(&org_id).bind(&grant_id).bind(&grant_id)
        .bind(format!("{claim_id}:9:api_calls:window"))
        .execute(state.db.pool()).await.unwrap();

    let mut conflict = keyed_body(&connection, "recover");
    conflict.parameters = Some(json!({"different": true}));
    assert_eq!(
        create(State(state.clone()), headers.clone(), Json(conflict))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    let state_before: String = sqlx::query_scalar(
        "SELECT state FROM authority_budget_reservations WHERE id = 'recovery-hold'",
    )
    .fetch_one(state.db.pool())
    .await
    .unwrap();
    assert_eq!(state_before, "reserved");
    let replay = create(
        State(state.clone()),
        headers,
        Json(keyed_body(&connection, "recover")),
    )
    .await;
    assert_eq!(replay.status(), StatusCode::OK);
    let state_after: String = sqlx::query_scalar(
        "SELECT state FROM authority_budget_reservations WHERE id = 'recovery-hold'",
    )
    .fetch_one(state.db.pool())
    .await
    .unwrap();
    assert_eq!(state_after, "settled");
}

#[tokio::test]
async fn a_replay_cannot_execute_if_its_prior_intent_disappears_before_dispatch() {
    let (state, org, connection, delegation) = fixture().await;
    let headers =
        crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
    let first = create(
        State(state.clone()),
        headers.clone(),
        Json(keyed_body(&connection, "removed-prior")),
    )
    .await;
    assert_eq!(first.status(), StatusCode::OK);

    super::super::intents_queue::hold_next_invoke();
    let retry = create(
        State(state.clone()),
        headers,
        Json(keyed_body(&connection, "removed-prior")),
    )
    .await;
    assert_eq!(retry.status(), StatusCode::ACCEPTED);
    let org_id = org.to_string();
    sqlx::query("DELETE FROM receipts WHERE invocation_id IN (SELECT inv.id FROM invocations inv JOIN intents i ON i.id = inv.intent_id WHERE i.organization_id = ? AND i.idempotency_key = ?)")
        .bind(&org_id).bind("removed-prior").execute(state.db.pool()).await.unwrap();
    sqlx::query("DELETE FROM invocations WHERE intent_id IN (SELECT id FROM intents WHERE organization_id = ? AND idempotency_key = ?)")
        .bind(&org_id).bind("removed-prior").execute(state.db.pool()).await.unwrap();
    sqlx::query("DELETE FROM intents WHERE organization_id = ? AND idempotency_key = ?")
        .bind(&org_id)
        .bind("removed-prior")
        .execute(state.db.pool())
        .await
        .unwrap();

    assert_eq!(
        super::super::intents_queue::drain(&state).await.status(),
        StatusCode::FORBIDDEN
    );
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM intents WHERE organization_id = ? AND idempotency_key = ?",
    )
    .bind(&org_id)
    .bind("removed-prior")
    .fetch_one(state.db.pool())
    .await
    .unwrap();
    assert_eq!(count, 0);
    assert_eq!(remaining(&state, &delegation).await, 0);
}
