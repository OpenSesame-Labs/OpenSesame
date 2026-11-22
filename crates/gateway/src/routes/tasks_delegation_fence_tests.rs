//! Frozen tasks currently use only the local, parentless bootstrap grant.

use super::*;
use opensesame_domain::GrantId;

#[tokio::test]
async fn a_delegated_bootstrap_cannot_freeze_or_spend_a_frozen_intent() {
    let state = crate::app_state::test_demo_state().await;
    let boot = state.bootstrap.lock().unwrap().clone().unwrap();
    assert!(execution_bootstrap_for_organization(&state, &boot.org, &boot.principal).is_ok());

    let mut frozen = tests::intent(boot.principal, boot.org, 5);
    frozen.project_id = Some(boot.project);
    frozen.actor_id = boot.actor;
    frozen.connection_id = Some(boot.connection);
    state
        .frozen_intents
        .lock()
        .unwrap()
        .insert(frozen.intent_digest.clone(), frozen.clone());
    let headers = crate::app_state::test_session_headers(
        &state,
        &boot.principal.to_string(),
        boot.org,
        opensesame_domain::OrganizationRole::Member,
    );
    for (parent, depth) in [(Some(GrantId::new()), 0), (None, 1)] {
        let mut child = boot.grant.clone();
        child.parent_grant_id = parent;
        child.delegation_depth = depth;
        state.bootstrap.lock().unwrap().as_mut().unwrap().grant = child;
        assert!(execution_bootstrap_for_organization(&state, &boot.org, &boot.principal).is_err());

        let response = invoke_task(
            State(state.clone()),
            headers.clone(),
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
}
