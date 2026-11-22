//! Model already-queued work from a Host before the temporary restriction.
use super::*;
use opensesame_domain::{ConnectionAuthorityBinding, ConnectionRef, ValidatedGrantChain};

async fn queue_legacy(
    state: &AppState,
    org: OrganizationId,
    connection: &str,
    delegation_id: &str,
    omit_identifier: bool,
) {
    let boot = state.bootstrap.lock().unwrap().as_ref().unwrap().clone();
    let row = broker_store::get_connection(state.connection_broker.pool(), connection)
        .await
        .unwrap()
        .unwrap();
    let live = state
        .connection_broker
        .find_live_delegation_by_id(GUEST, delegation_id)
        .await
        .unwrap()
        .unwrap();
    let connection_id = ConnectionId::parse(connection).unwrap();
    let connection_ref = ConnectionRef::new(org, None, row.logical_name, connection_id).unwrap();
    let lineage = ValidatedGrantChain::try_validate(
        &[live.parent_grant.clone(), live.grant.clone()],
        Utc::now(),
        0,
    )
    .unwrap();
    let resolved = ResolvedInvocation {
        grant: live.grant.clone(),
        lineage: Some(lineage),
        delegation_chain: vec![live.parent_grant_id, live.grant.id],
        connection_id,
        principal_id: live.grant.beneficiary_principal_id,
        binding: ConnectionAuthorityBinding {
            connection_ref,
            internal_secret: None,
            credential_handle: None,
            egress: row.egress,
            max_invoke_level: InvokeLevel::TypedOperation,
        },
        connection_policy_id: "demo-conn".into(),
        spend_budget: if omit_identifier {
            None
        } else {
            Some(delegation_id.to_owned())
        },
        broker_connection: true,
    };
    let parameters = json!({});
    let intent = build_intent(
        invoke_body(connection, "repository.read"),
        &parameters,
        &boot,
        &resolved,
    )
    .unwrap();
    let input = InvokeInput {
        intent,
        grant: resolved.grant.clone(),
        subject: GUEST.into(),
        connection_policy_id: resolved.connection_policy_id.clone(),
        parameters,
        lineage: resolved.lineage.clone(),
    };
    super::super::intents_queue::hold_next_invoke();
    let held =
        super::super::intents_queue::dispatch_or_hold(state, org, resolved, input, None, None, 1)
            .await;
    assert_eq!(held.status(), StatusCode::ACCEPTED);
    assert_eq!(super::super::intents_queue::fixture_work(), 0);
}

#[tokio::test]
async fn held_delegation_is_refused_without_starting_fixture_work() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let connection = delegable_github_row(&state, org).await;
    let delegation = delegate_to_guest(&state, org, &connection).await;
    queue_legacy(&state, org, &connection, &delegation[0].id, false).await;
    let response = super::super::intents_queue::drain(&state).await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(super::super::intents_queue::fixture_work(), 0);
}

#[tokio::test]
async fn revoked_held_delegation_cannot_start_fixture_work() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let connection = delegable_github_row(&state, org).await;
    let delegation = delegate_to_guest(&state, org, &connection).await;
    queue_legacy(&state, org, &connection, &delegation[0].id, false).await;
    state
        .connection_broker
        .revoke_delegation(&org, OWNER, &delegation[0].id)
        .await
        .unwrap();
    let response = super::super::intents_queue::drain(&state).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(super::super::intents_queue::fixture_work(), 0);
}

#[tokio::test]
async fn expired_held_delegation_cannot_start_fixture_work() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let connection = delegable_github_row(&state, org).await;
    let delegation = delegate_to_guest(&state, org, &connection).await;
    queue_legacy(&state, org, &connection, &delegation[0].id, false).await;
    let past = (Utc::now() - opensesame_time::Duration::hours(1)).to_rfc3339();
    sqlx::query("UPDATE connection_delegations SET expires_at = ? WHERE id = ?")
        .bind(past)
        .bind(&delegation[0].id)
        .execute(state.connection_broker.pool())
        .await
        .unwrap();
    let response = super::super::intents_queue::drain(&state).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(super::super::intents_queue::fixture_work(), 0);
}

#[tokio::test]
async fn changed_mode_of_held_delegation_cannot_start_fixture_work() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let connection = delegable_github_row(&state, org).await;
    let delegation = delegate_to_guest(&state, org, &connection).await;
    queue_legacy(&state, org, &connection, &delegation[0].id, false).await;
    sqlx::query("UPDATE connection_delegations SET execution_mode = 'relay' WHERE id = ?")
        .bind(&delegation[0].id)
        .execute(state.connection_broker.pool())
        .await
        .unwrap();
    let response = super::super::intents_queue::drain(&state).await;
    assert_eq!(response.status(), StatusCode::NOT_IMPLEMENTED);
    assert_eq!(super::super::intents_queue::fixture_work(), 0);
}

#[tokio::test]
async fn held_child_with_missing_delegation_identity_is_refused() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let connection = delegable_github_row(&state, org).await;
    let delegation = delegate_to_guest(&state, org, &connection).await;
    queue_legacy(&state, org, &connection, &delegation[0].id, true).await;
    let response = super::super::intents_queue::drain(&state).await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(super::super::intents_queue::fixture_work(), 0);
}
