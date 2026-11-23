use super::*;
use axum::extract::State;
use opensesame_connection_broker::delegation::{
    ClaimOfferRequest, MintOfferRequest, OfferItemSpec,
};
use opensesame_connection_broker::model::ConnectionStatus;
use opensesame_connection_broker::store as broker_store;

const OWNER: &str = "principal:00000000-0000-4000-8000-000000000008";
const GUEST: &str = "principal:00000000-0000-4000-8000-000000000013";

async fn delegable_github_row(state: &crate::app_state::AppState, org: OrganizationId) -> String {
    let now = Utc::now();
    let row = broker_store::ConnectionRow {
        id: ConnectionId::new().to_string(),
        organization_id: org.to_string(),
        project_id: None,
        provider_id: "github".into(),
        integration_id: "deployment:github".into(),
        logical_name: "github-owner".into(),
        display_name: "Owner's GitHub".into(),
        status: ConnectionStatus::Active,
        status_detail: None,
        requested_scopes: vec![],
        granted_scopes: vec![],
        account_label: None,
        owner_kind: "user".into(),
        owner_subject: Some(OWNER.into()),
        shareability: "delegable".into(),
        max_invoke_level: 2,
        materialization: "deny".into(),
        egress: EgressBinding {
            scheme: "https".into(),
            authorities: vec!["api.github.com".into()],
            path_prefixes: vec![],
            allow_redirects_cross_authority: false,
        },
        created_at: now,
        updated_at: now,
    };
    broker_store::insert_connection(state.connection_broker.pool(), &row)
        .await
        .expect("insert broker connection");
    row.id
}

async fn delegate_to_guest(
    state: &crate::app_state::AppState,
    org: OrganizationId,
    connection_id: &str,
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
                    budgets: None,
                    execution_mode: opensesame_relay::ExecutionMode::Relay,
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
    let delegations = state
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
        .expect("claim");
    // Model a broker-mode row created before the temporary restriction.
    sqlx::query("UPDATE connection_delegations SET execution_mode = 'broker' WHERE id = ?")
        .bind(&delegations[0].id)
        .execute(state.connection_broker.pool())
        .await
        .unwrap();
    delegations
}

fn invoke_body(connection_ref: &str, operation: &str) -> InvokeBody {
    InvokeBody {
        connection_ref: Some(connection_ref.into()),
        connection: None,
        operation: operation.into(),
        resource: "repo:acme/catalog".into(),
        audience: Some("https://api.github.com".into()),
        parameters: Some(json!({})),
        idempotency_key: None,
        invoke_level: None,
        task_run_id: None,
        intent_digest: None,
    }
}

#[tokio::test]
async fn existing_broker_delegation_is_temporarily_refused_before_execution() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let connection = delegable_github_row(&state, org).await;
    delegate_to_guest(&state, org, &connection).await;
    let headers =
        crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
    let response = create(
        State(state),
        headers,
        Json(invoke_body(&connection, "repository.read")),
    )
    .await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let bytes = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["error"], "delegated_execution_unavailable");
}

#[tokio::test]
async fn owner_can_reach_constrained_http_without_delegating_to_itself() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let connection_id = delegable_github_row(&state, org).await;
    let connection_ref = state
        .connection_broker
        .get_connection(&org, &connection_id)
        .await
        .expect("connection")
        .connection_ref;
    let headers =
        crate::app_state::test_session_headers(&state, OWNER, org, OrganizationRole::Member);
    let mut body = invoke_body(&connection_ref, "repository.read");
    body.invoke_level = Some(2);

    let response = create(State(state), headers, Json(body)).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .expect("body");
    let problem: Value = serde_json::from_slice(&bytes).expect("problem json");
    assert_eq!(
        problem["error"],
        json!("url is required for constrained HTTP")
    );
}

#[tokio::test]
async fn adversarial_the_same_ref_is_nothing_to_anyone_else() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let connection_id = delegable_github_row(&state, org).await;
    delegate_to_guest(&state, org, &connection_id).await;

    let headers = crate::app_state::test_session_headers(
        &state,
        "principal:00000000-0000-4000-8000-000000000014",
        org,
        OrganizationRole::Member,
    );
    let response = create(
        State(state.clone()),
        headers,
        Json(invoke_body(&connection_id, "repository.read")),
    )
    .await;
    // Knowing the connection id is not authorization, and the refusal
    // must not confirm the connection exists.
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn delegated_actions_are_refused_before_execution() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let connection_id = delegable_github_row(&state, org).await;
    delegate_to_guest(&state, org, &connection_id).await;

    // The owner's ceiling allows pull_request.create; the child grant
    // deliberately does not. The delegate must be held to the child.
    let headers =
        crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
    let response = create(
        State(state.clone()),
        headers,
        Json(invoke_body(&connection_id, "pull_request.create")),
    )
    .await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn contract_revocation_ends_delegated_exercise() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let connection_id = delegable_github_row(&state, org).await;
    let delegations = delegate_to_guest(&state, org, &connection_id).await;
    state
        .connection_broker
        .revoke_delegation(&org, OWNER, &delegations[0].id)
        .await
        .expect("revoke");

    let headers =
        crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
    let response = create(
        State(state.clone()),
        headers,
        Json(invoke_body(&connection_id, "repository.read")),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn blocked_delegated_calls_do_not_spend_the_budget() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let connection_id = delegable_github_row(&state, org).await;
    let minted = state
        .connection_broker
        .mint_delegation_offer(
            &org,
            OWNER,
            MintOfferRequest {
                items: vec![OfferItemSpec {
                    connection_id: connection_id.clone(),
                    actions: Some(vec!["repository.read".into()]),
                    resources: None,
                    expires_in_seconds: None,
                    budgets: Some(
                        [(
                            opensesame_connection_broker::delegation::BUDGET_INVOCATIONS
                                .to_string(),
                            1,
                        )]
                        .into_iter()
                        .collect(),
                    ),
                    execution_mode: opensesame_relay::ExecutionMode::Relay,
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
    let claimed = state
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
        .expect("claim");
    sqlx::query("UPDATE connection_delegations SET execution_mode = 'broker' WHERE id = ?")
        .bind(&claimed[0].id)
        .execute(state.connection_broker.pool())
        .await
        .unwrap();

    let headers =
        crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
    let first = create(
        State(state.clone()),
        headers.clone(),
        Json(invoke_body(&connection_id, "repository.read")),
    )
    .await;
    assert_eq!(first.status(), StatusCode::SERVICE_UNAVAILABLE);
    let second = create(
        State(state.clone()),
        headers,
        Json(invoke_body(&connection_id, "repository.read")),
    )
    .await;
    assert_eq!(second.status(), StatusCode::SERVICE_UNAVAILABLE);
    let remaining: String =
        sqlx::query_scalar("SELECT budget_remaining FROM connection_delegations WHERE id = ?")
            .bind(&claimed[0].id)
            .fetch_one(state.connection_broker.pool())
            .await
            .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&remaining).unwrap()["invocations"],
        1
    );
}

#[path = "intents_legacy_queue_tests.rs"]
mod legacy_queue_tests;

#[path = "intents_relay_mode_tests.rs"]
mod relay_mode_tests;

#[path = "intents_budget_retry_tests.rs"]
mod budget_retry_tests;

#[path = "intents_effect_fence_tests.rs"]
mod effect_fence_tests;
