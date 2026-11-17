use super::*;

#[tokio::test]
async fn same_principals_in_another_organization_cannot_access_or_decide_a_relay() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let other_org = OrganizationId::new();
    let delegation = relay_delegation(&state, org, ExecutionMode::Relay).await;
    let holder =
        crate::app_state::test_session_headers(&state, OWNER, org, OrganizationRole::Member);
    let delegate =
        crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
    let other_holder =
        crate::app_state::test_session_headers(&state, OWNER, other_org, OrganizationRole::Member);
    let other_delegate =
        crate::app_state::test_session_headers(&state, GUEST, other_org, OrganizationRole::Member);

    // A heartbeat in the other organization cannot make this holder online.
    heartbeat(State(state.clone()), other_holder.clone()).await;
    let offline = submit(
        State(state.clone()),
        delegate.clone(),
        Json(submit_body(&delegation)),
    )
    .await;
    assert_eq!(offline.status(), StatusCode::CONFLICT);
    assert_eq!(body_json(offline).await["error"], json!("holder_offline"));

    let (id, digest) = open_relay_request(&state, &holder, &delegate, &delegation).await;
    let other_inbox = body_json(pending(State(state.clone()), other_holder.clone()).await).await;
    assert_eq!(other_inbox["requests"], json!([]));
    for headers in [&other_holder, &other_delegate] {
        assert_eq!(
            get(State(state.clone()), headers.clone(), Path(id.clone()))
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
    }
    for approve_request in [true, false] {
        let reply = decide(
            &state,
            &other_holder,
            &id,
            DecideRequest {
                request_digest: digest.clone(),
            },
            approve_request,
        )
        .await;
        assert_eq!(reply.status(), StatusCode::NOT_FOUND);
    }
    assert!(current_authority(&state, &id, other_org, OWNER)
        .await
        .is_err());
    assert_eq!(
        result(
            State(state.clone()),
            other_holder.clone(),
            Path(id.clone()),
            Json(ResultRequest {
                executed_digest: digest.clone(),
                outcome: "succeeded".into(),
                safe_summary: None,
            })
        )
        .await
        .status(),
        StatusCode::NOT_FOUND,
    );

    // The correct organization's holder can still approve and complete it.
    approve_and_complete_relay(&state, &holder, &id, &digest).await;
    assert_eq!(
        get(State(state.clone()), delegate, Path(id.clone()))
            .await
            .status(),
        StatusCode::OK
    );
    for headers in [other_holder, other_delegate] {
        assert_eq!(
            get(State(state.clone()), headers, Path(id.clone()))
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
    }
}
