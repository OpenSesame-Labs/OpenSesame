//! Pre-existing requests retain scoped inspection, denial, and result reporting.

use super::*;

#[tokio::test]
async fn legacy_requests_can_be_inspected_and_denied_only_by_their_tenant() {
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
    let (id, _) = seed_request(&state, org, &delegation, "pending_approval").await;

    for headers in [&other_holder, &other_delegate] {
        assert_eq!(
            get(State(state.clone()), headers.clone(), Path(id.clone()))
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(
        deny(
            State(state.clone()),
            other_holder,
            Path(id.clone()),
            Json(json!({}))
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );

    let details =
        body_json(get(State(state.clone()), delegate.clone(), Path(id.clone())).await).await;
    assert_eq!(
        details,
        json!({"id":id,"state":"pending_approval","outcome":null})
    );
    assert_eq!(
        deny(
            State(state.clone()),
            holder,
            Path(id.clone()),
            Json(json!({}))
        )
        .await
        .status(),
        StatusCode::OK
    );
    let denied = body_json(get(State(state), delegate, Path(id)).await).await;
    assert_eq!(denied["state"], "denied");
}

#[tokio::test]
async fn legacy_read_never_discloses_executable_fields_or_holder_summary() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let delegation = relay_delegation(&state, org, ExecutionMode::Relay).await;
    let holder =
        crate::app_state::test_session_headers(&state, OWNER, org, OrganizationRole::Member);
    let delegate =
        crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
    let (id, _) = seed_request(&state, org, &delegation, "completed").await;
    sqlx::query("UPDATE relay_requests SET operation = ?, resource = ?, request_digest = ?, result_json = ?, result_outcome = ? WHERE id = ?")
        .bind("operation-sentinel")
        .bind("resource-sentinel")
        .bind("digest-sentinel")
        .bind(r#"{"note":"cmVsYXktc2VudGluZWw="}"#)
        .bind("succeeded")
        .bind(&id)
        .execute(state.connection_broker.pool()).await.unwrap();
    for headers in [holder, delegate] {
        let response = get(State(state.clone()), headers, Path(id.clone())).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            body_json(response).await,
            json!({"id": id, "state":"completed", "outcome":"succeeded"})
        );
    }
}

#[tokio::test]
async fn a_live_previously_approved_request_can_report_its_bound_result_once() {
    let state = crate::app_state::test_demo_state().await;
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let delegation = relay_delegation(&state, org, ExecutionMode::Relay).await;
    let holder =
        crate::app_state::test_session_headers(&state, OWNER, org, OrganizationRole::Member);
    let (id, digest) = seed_request(&state, org, &delegation, "approved").await;
    let wrong = result(
        State(state.clone()),
        holder.clone(),
        Path(id.clone()),
        Json(ResultRequest {
            executed_digest: "sha256:wrong".into(),
            outcome: "succeeded".into(),
            safe_summary: None,
        }),
    )
    .await;
    assert_eq!(wrong.status(), StatusCode::CONFLICT);
    let report = || ResultRequest {
        executed_digest: digest.clone(),
        outcome: "succeeded".into(),
        safe_summary: Some(json!({"note":"cmVsYXktc2VudGluZWw="})),
    };
    assert_eq!(
        result(
            State(state.clone()),
            holder.clone(),
            Path(id.clone()),
            Json(report())
        )
        .await
        .status(),
        StatusCode::OK
    );
    let stored: Option<String> =
        sqlx::query_scalar("SELECT result_json FROM relay_requests WHERE id = ?")
            .bind(&id)
            .fetch_one(state.connection_broker.pool())
            .await
            .unwrap();
    assert_eq!(stored, None);
    assert!(!result(State(state), holder, Path(id), Json(report()))
        .await
        .status()
        .is_success());
}
