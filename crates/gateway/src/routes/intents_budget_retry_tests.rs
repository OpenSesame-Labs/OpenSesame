//! Owner retries exercise the budget path while delegated execution is disabled.

use super::*;
use axum::http::HeaderMap;
use opensesame_storage::authority::{
    AuthorityIssue, BudgetScope, NewAccessDomain, PermissionEntry,
};
use opensesame_time::Duration;
use std::sync::Arc;

#[path = "intents_opening_log_tests.rs"]
mod opening_log_tests;

async fn fixture() -> (AppState, HeaderMap, OrganizationId, String) {
    let mut state = crate::app_state::test_demo_state().await;
    let boot = state.bootstrap.lock().unwrap().as_ref().unwrap().clone();
    let subject = boot.principal.to_string();
    Arc::get_mut(&mut state.broker)
        .unwrap()
        .policy
        .assurance
        .insert(subject.clone(), "mfa".into());
    let headers = crate::app_state::test_session_headers(
        &state,
        &subject,
        boot.org,
        OrganizationRole::Member,
    );
    let organization = boot.org.to_string();
    let grant = boot.grant.id.to_string();
    let domain = format!("domain:{}", uuid::Uuid::new_v4());
    state
        .db
        .create_access_domain(&NewAccessDomain {
            id: &domain,
            organization_id: &organization,
            parent_id: None,
            project_id: None,
        })
        .await
        .unwrap();
    let now = Utc::now();
    assert!(state
        .db
        .issue_authority(
            &AuthorityIssue {
                grant_id: &grant,
                organization_id: &organization,
                domain_id: &domain,
                parent_grant_id: None,
                issuance_basis: "root",
                lineage_digest: "digest:lineage",
                policy_digest: "digest:policy",
                role_revision: None,
                offer_id: None,
                delegation_depth_remaining: 0,
                not_before: now - Duration::minutes(1),
                expires_at: now + Duration::hours(1),
                evidence_id: None,
            },
            &[PermissionEntry {
                resource_selector: "repo:acme/catalog".into(),
                provider_operation_id: "repository.read".into(),
                action_set_json: "[\"repository.read\"]".into(),
                parameter_constraints_json: "{}".into(),
                audience_set_json: "[]".into(),
                manifest_digest: "digest:manifest".into(),
            }],
        )
        .await
        .unwrap());
    assert!(state
        .db
        .set_authority_budget(
            &BudgetScope {
                organization_id: &organization,
                scope_kind: "root_grant",
                scope_id: &grant,
                unit: "api_calls",
                window_key: "window",
            },
            1,
        )
        .await
        .unwrap());
    (state, headers, boot.org, grant)
}

fn body(key: &str) -> InvokeBody {
    let mut body = invoke_body("", "repository.read");
    body.idempotency_key = Some(key.into());
    body
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

async fn budget(state: &AppState, org: OrganizationId, grant: &str) -> (i64, i64) {
    sqlx::query_as(
        "SELECT settled_usage, outstanding_reservations FROM authority_budgets \
         WHERE organization_id = ? AND scope_kind = 'root_grant' AND scope_id = ?",
    )
    .bind(org.to_string())
    .bind(grant)
    .fetch_one(state.db.pool())
    .await
    .unwrap()
}

#[tokio::test]
async fn matching_owner_retry_reuses_receipt_without_spending_again() {
    let (state, headers, org, grant) = fixture().await;
    let first =
        receipt_id(create(State(state.clone()), headers.clone(), Json(body("retry"))).await).await;
    assert_eq!(budget(&state, org, &grant).await, (1, 0));
    let replay =
        receipt_id(create(State(state.clone()), headers.clone(), Json(body("retry"))).await).await;
    assert_eq!(first, replay);
    let mut changed = body("retry");
    changed.parameters = Some(json!({"different": true}));
    assert!(
        !create(State(state.clone()), headers.clone(), Json(changed))
            .await
            .status()
            .is_success()
    );
    assert_eq!(
        create(State(state.clone()), headers, Json(body("new")))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(budget(&state, org, &grant).await, (1, 0));
}

#[tokio::test]
async fn private_opening_is_bound_to_original_receipt_and_caller() {
    let (state, headers, org, grant) = fixture().await;
    let first_response = create(
        State(state.clone()),
        headers.clone(),
        Json(body("private-opening")),
    )
    .await;
    assert_eq!(first_response.status(), StatusCode::OK);
    assert_eq!(first_response.headers()["cache-control"], "no-store");
    let first: Value = serde_json::from_slice(
        &axum::body::to_bytes(first_response.into_body(), 1 << 20)
            .await
            .unwrap(),
    )
    .unwrap();
    let receipt: opensesame_domain::InvocationReceipt =
        serde_json::from_value(first.clone()).unwrap();
    state.receipt_verifier.verify(&receipt).unwrap();
    let opening = first["intent_opening"]["opening"].as_str().unwrap();
    let raw_digest = first["intent_opening"]["intent_digest"].as_str().unwrap();
    let original: Intent =
        serde_json::from_value(first["intent_opening"]["intent"].clone()).unwrap();
    assert_eq!(original.digest().unwrap(), raw_digest);
    assert!(receipt.verifies_intent_opening(opening, raw_digest));

    let replay = create(
        State(state.clone()),
        headers.clone(),
        Json(body("private-opening")),
    )
    .await;
    assert_eq!(replay.status(), StatusCode::OK);
    assert_eq!(replay.headers()["cache-control"], "no-store");
    let replay: Value = serde_json::from_slice(
        &axum::body::to_bytes(replay.into_body(), 1 << 20)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(first["id"], replay["id"]);
    assert_eq!(first["intent_opening"], replay["intent_opening"]);

    let subject = state
        .bootstrap
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .principal
        .to_string();
    let new_session =
        crate::app_state::test_session_headers(&state, &subject, org, OrganizationRole::Member);
    let mut operator = HeaderMap::new();
    operator.insert(
        "x-opensesame-operator",
        state.operator_token.parse().unwrap(),
    );
    for authorized in [new_session, operator] {
        let response = create(
            State(state.clone()),
            authorized,
            Json(body("private-opening")),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let value: Value = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), 1 << 20)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(value["intent_opening"], first["intent_opening"]);
    }
    assert_eq!(budget(&state, org, &grant).await, (1, 0));

    let stored = state.db.get_receipt(&receipt.id).await.unwrap().unwrap();
    let stored_json = serde_json::to_string(&stored.receipt).unwrap();
    assert!(!stored_json.contains(opening));
    assert!(!stored_json.contains(raw_digest));
    let get_response = crate::routes::receipts::get(
        State(state.clone()),
        headers.clone(),
        axum::extract::Path(receipt.id.to_string()),
    )
    .await;
    assert_eq!(get_response.status(), StatusCode::OK);
    let get_body = axum::body::to_bytes(get_response.into_body(), 1 << 20)
        .await
        .unwrap();
    let get_text = std::str::from_utf8(&get_body).unwrap();
    assert!(!get_text.contains(opening));
    assert!(!get_text.contains(raw_digest));
    assert!(!get_text.contains("intent_opening"));
    let verification = crate::routes::receipts::verify(
        State(state.clone()),
        headers.clone(),
        axum::extract::Path(receipt.id.to_string()),
    )
    .await;
    assert_eq!(verification.status(), StatusCode::OK);
    let verified = axum::body::to_bytes(verification.into_body(), 1 << 20)
        .await
        .unwrap();
    assert!(!std::str::from_utf8(&verified).unwrap().contains(opening));

    let stranger = crate::app_state::test_session_headers(
        &state,
        &PrincipalId::new().to_string(),
        org,
        OrganizationRole::Member,
    );
    let refused = create(
        State(state.clone()),
        stranger,
        Json(body("private-opening")),
    )
    .await;
    assert!(!refused.status().is_success());
    let refusal = axum::body::to_bytes(refused.into_body(), 1 << 20)
        .await
        .unwrap();
    assert!(!std::str::from_utf8(&refusal).unwrap().contains(opening));

    // The invocation's outbox and connection events must not gain the secret.
    let events: Vec<String> = sqlx::query_scalar(
        "SELECT payload_json FROM outbox_events UNION ALL SELECT COALESCE(detail, '') FROM connection_events",
    )
    .fetch_all(state.db.pool())
    .await
    .unwrap();
    for event in events {
        assert!(!event.contains(opening));
    }
}

#[tokio::test]
async fn concurrent_owner_retries_cannot_spend_twice() {
    let (state, headers, org, grant) = fixture().await;
    let (one, two) = tokio::join!(
        create(
            State(state.clone()),
            headers.clone(),
            Json(body("concurrent"))
        ),
        create(State(state.clone()), headers, Json(body("concurrent"))),
    );
    let statuses = [one.status(), two.status()];
    assert!(statuses.contains(&StatusCode::OK));
    assert!(statuses.iter().all(|status| matches!(
        *status,
        StatusCode::OK | StatusCode::CONFLICT | StatusCode::FORBIDDEN
    )));
    assert_eq!(budget(&state, org, &grant).await, (1, 0));
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM invocation_budget_claims WHERE organization_id = ? AND idempotency_key = ?",
    )
    .bind(org.to_string()).bind("concurrent").fetch_one(state.db.pool()).await.unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn a_queued_replay_never_executes_after_its_prior_record_disappears() {
    let (state, headers, org, grant) = fixture().await;
    assert_eq!(
        create(State(state.clone()), headers.clone(), Json(body("removed")))
            .await
            .status(),
        StatusCode::OK
    );
    intents_queue::hold_next_invoke();
    assert_eq!(
        create(State(state.clone()), headers, Json(body("removed")))
            .await
            .status(),
        StatusCode::ACCEPTED
    );
    let organization = org.to_string();
    sqlx::query("DELETE FROM receipts WHERE invocation_id IN (SELECT v.id FROM invocations v JOIN intents i ON i.id = v.intent_id WHERE i.organization_id = ? AND i.idempotency_key = ?)")
        .bind(&organization).bind("removed").execute(state.db.pool()).await.unwrap();
    sqlx::query("DELETE FROM invocations WHERE intent_id IN (SELECT id FROM intents WHERE organization_id = ? AND idempotency_key = ?)")
        .bind(&organization).bind("removed").execute(state.db.pool()).await.unwrap();
    sqlx::query("DELETE FROM intents WHERE organization_id = ? AND idempotency_key = ?")
        .bind(&organization)
        .bind("removed")
        .execute(state.db.pool())
        .await
        .unwrap();
    assert_eq!(
        intents_queue::drain(&state).await.status(),
        StatusCode::FORBIDDEN
    );
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM intents WHERE organization_id = ? AND idempotency_key = ?",
    )
    .bind(&organization)
    .bind("removed")
    .fetch_one(state.db.pool())
    .await
    .unwrap();
    assert_eq!(count, 0);
    assert_eq!(budget(&state, org, &grant).await, (1, 0));
}

#[tokio::test]
async fn omitted_idempotency_key_is_shared_by_the_budget_and_intent() {
    let (state, headers, org, _) = fixture().await;
    let mut request = body("unused");
    request.idempotency_key = None;
    assert_eq!(
        create(State(state.clone()), headers, Json(request))
            .await
            .status(),
        StatusCode::OK
    );
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM intents i JOIN invocation_budget_claims c \
         ON c.organization_id = i.organization_id AND c.idempotency_key = i.idempotency_key \
         WHERE i.organization_id = ?",
    )
    .bind(org.to_string())
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
