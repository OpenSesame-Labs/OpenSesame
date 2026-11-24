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
async fn changed_relay_row_cannot_fall_back_to_broker_execution() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let connection = delegable_github_row(&state, org).await;
    let delegation = relay_delegation(&state, org, &connection).await;
    sqlx::query("UPDATE connection_delegations SET execution_mode = 'broker' WHERE id = ?")
        .bind(&delegation)
        .execute(state.connection_broker.pool())
        .await
        .unwrap();
    let headers =
        crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
    let response = create(
        State(state.clone()),
        headers,
        Json(invoke_body(&connection, "repository.read")),
    )
    .await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let invocations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM invocations")
        .fetch_one(state.db.pool())
        .await
        .unwrap();
    assert_eq!(invocations, 0);
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

#[tokio::test]
async fn bootstrap_child_grant_cannot_bypass_the_delegation_gate() {
    let state = crate::app_state::test_demo_state().await;
    let boot = state.bootstrap.lock().unwrap().as_ref().unwrap().clone();
    let headers = crate::app_state::test_session_headers(
        &state,
        &boot.principal.to_string(),
        boot.org,
        OrganizationRole::Member,
    );
    for (parent, depth) in [(Some(opensesame_domain::GrantId::new()), 0), (None, 1)] {
        let mut grant = boot.grant.clone();
        grant.parent_grant_id = parent;
        grant.delegation_depth = depth;
        state.bootstrap.lock().unwrap().as_mut().unwrap().grant = grant;
        let response = create(
            State(state.clone()),
            headers.clone(),
            Json(invoke_body("", "repository.read")),
        )
        .await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM invocations")
        .fetch_one(state.db.pool())
        .await
        .unwrap();
    assert_eq!(count, 0);
}

const STORED_MODES: [(&str, &str); 7] = [
    ("StoredMode.relay", "relay"),
    ("StoredMode.broker", "broker"),
    ("StoredMode.upper", "Relay"),
    ("StoredMode.shout", "BROKER"),
    ("StoredMode.padded", " relay"),
    ("StoredMode.empty", ""),
    ("StoredMode.unknown", "unknown"),
];

fn mode_vectors() -> Vec<Vec<String>> {
    let path = std::env::var("OPENSESAME_HOST_CLI_VECTORS").expect("run the host-cli verifier");
    let text = std::fs::read_to_string(path).expect("read formal vectors");
    text.lines()
        .map(|line| line.split('\t').map(str::to_owned).collect::<Vec<_>>())
        .filter(|fields| fields[0] == "mode")
        .map(|fields| fields[1..].to_vec())
        .collect()
}

async fn invoke_outcome(state: &crate::app_state::AppState, connection: &str) -> String {
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let headers =
        crate::app_state::test_session_headers(state, GUEST, org, OrganizationRole::Member);
    let body = Json(invoke_body(connection, "repository.read"));
    let response = create(State(state.clone()), headers, body).await;
    let status = response.status().as_u16();
    let bytes = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let invocations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM invocations")
        .fetch_one(state.db.pool())
        .await
        .unwrap();
    match (status, body["error"].as_str(), invocations) {
        (501, Some("relay_execution_unavailable"), 0) => "Invoke.relayUnavailable".into(),
        (503, Some("delegated_execution_unavailable"), 0) => "Invoke.delegatedUnavailable".into(),
        (404, _, 0) => "Invoke.notFound".into(),
        _ => format!("other:{status}:{body}:{invocations}"),
    }
}

#[tokio::test]
#[ignore = "requires Lean vectors; run spec/formal/host-cli/verify.sh"]
async fn lean_mode_vectors_match_delegated_invocation() {
    let cases = mode_vectors();
    for f in &cases {
        let raw = STORED_MODES
            .iter()
            .find(|(m, _)| *m == f[0])
            .expect("mode")
            .1;
        let state = crate::app_state::test_demo_state().await;
        let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
        let connection = delegable_github_row(&state, org).await;
        let delegation = relay_delegation(&state, org, &connection).await;
        sqlx::query("UPDATE connection_delegations SET execution_mode = ? WHERE id = ?")
            .bind(raw)
            .bind(&delegation)
            .execute(state.connection_broker.pool())
            .await
            .unwrap();
        let resolved = state
            .connection_broker
            .find_live_delegation_by_id(GUEST, &delegation)
            .await
            .unwrap()
            .map(|live| live.execution_mode);
        let resolved = match resolved {
            None => "none",
            Some(ExecutionMode::Relay) => "some (Mode.relay)",
            Some(ExecutionMode::Broker) => "some (Mode.broker)",
        };
        let actual = format!("{resolved}\t{}", invoke_outcome(&state, &connection).await);
        let expected = format!("{}\t{}", f[1], f[3]);
        assert_eq!(
            actual,
            expected,
            "decision mismatch for mode {}",
            f.join(" ")
        );
    }
    assert_eq!(cases.len(), 7, "incomplete mode vectors");
}
