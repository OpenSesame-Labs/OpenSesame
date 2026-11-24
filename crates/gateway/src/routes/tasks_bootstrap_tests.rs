//! Bootstrap scoping for frozen task authority.

use super::*;

#[path = "tasks_opening_tests.rs"]
mod opening_tests;

use axum::http::HeaderMap;
use opening_tests::{body, recover};
use opensesame_domain::{InvocationReceipt, OrganizationRole};
use std::sync::Arc;

#[tokio::test]
async fn non_bootstrap_organization_cannot_freeze_an_unusable_intent() {
    let state = crate::app_state::test_demo_state().await;
    let bootstrap = state.bootstrap.lock().unwrap().clone().unwrap();
    let organization_id = OrganizationId::new();
    let subject = bootstrap.principal.to_string();
    let headers = crate::app_state::test_session_headers(
        &state,
        &subject,
        organization_id,
        opensesame_domain::OrganizationRole::Member,
    );
    let started = start_task(
        State(state.clone()),
        headers.clone(),
        Json(StartTaskBody {
            principal_id: subject,
            organization_id: organization_id.to_string(),
            capabilities: vec![CapabilityDto {
                action: "repository.read".into(),
                resource: "repo:acme/catalog".into(),
            }],
            ttl_seconds: 60,
        }),
    )
    .await
    .unwrap();
    let started = axum::body::to_bytes(started.into_body(), usize::MAX)
        .await
        .unwrap();
    let started: serde_json::Value = serde_json::from_slice(&started).unwrap();

    let response = freeze_intent(
        State(state.clone()),
        headers,
        Json(FreezeIntentBody {
            task_run_id: started["task_run_id"].as_str().unwrap().into(),
            expected_state_version: started["state_version"].as_u64().unwrap(),
            operation: "repository.read".into(),
            resource: "repo:acme/catalog".into(),
            audience: "https://api.example.com".into(),
            arguments: serde_json::json!({}),
            idempotency_key: "foreign-org".into(),
        }),
    )
    .await
    .unwrap_err();

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(state.frozen_intents.lock().unwrap().is_empty());
}

#[tokio::test]
async fn operator_cannot_freeze_for_a_principal_the_grant_does_not_cover() {
    let state = crate::app_state::test_demo_state().await;
    let bootstrap = state.bootstrap.lock().unwrap().clone().unwrap();
    let principal = PrincipalId::new();
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        "x-opensesame-operator",
        state.operator_token.parse().unwrap(),
    );
    let started = start_task(
        State(state.clone()),
        headers.clone(),
        Json(StartTaskBody {
            principal_id: principal.to_string(),
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
    let started = axum::body::to_bytes(started.into_body(), usize::MAX)
        .await
        .unwrap();
    let started: serde_json::Value = serde_json::from_slice(&started).unwrap();

    let response = freeze_intent(
        State(state.clone()),
        headers,
        Json(FreezeIntentBody {
            task_run_id: started["task_run_id"].as_str().unwrap().into(),
            expected_state_version: started["state_version"].as_u64().unwrap(),
            operation: "repository.read".into(),
            resource: "repo:acme/catalog".into(),
            audience: "https://api.github.com".into(),
            arguments: serde_json::json!({}),
            idempotency_key: "wrong-beneficiary".into(),
        }),
    )
    .await
    .unwrap_err();

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(state.frozen_intents.lock().unwrap().is_empty());
}

/// INV-O2 gateway: every Lean case of `tasks_opening::recover`, for five
/// callers, four recovery bodies and five authority states.
#[tokio::test]
#[ignore = "run by verify:invocation-formal with OPENSESAME_INVOCATION_EFFECT_VECTORS"]
async fn lean_recovery_vectors_match_the_gateway() {
    let mut state = crate::app_state::test_demo_state().await;
    let boot = state.bootstrap.lock().unwrap().clone().unwrap();
    let subject = boot.principal.to_string();
    let broker = Arc::get_mut(&mut state.broker).unwrap();
    broker
        .policy
        .assurance
        .insert(subject.clone(), "mfa".into());
    let session = |principal: &str, org| {
        crate::app_state::test_session_headers(&state, principal, org, OrganizationRole::Member)
    };
    let owner = session(&subject, boot.org);
    let capability = CapabilityDto {
        action: "repository.read".into(),
        resource: "repo:acme/catalog".into(),
    };
    let task = StartTaskBody {
        principal_id: subject.clone(),
        organization_id: boot.org.to_string(),
        capabilities: vec![capability],
        ttl_seconds: 60,
    };
    let task = body(
        start_task(State(state.clone()), owner.clone(), Json(task))
            .await
            .unwrap(),
    )
    .await;
    let freeze = FreezeIntentBody {
        task_run_id: task["task_run_id"].as_str().unwrap().into(),
        expected_state_version: task["state_version"].as_u64().unwrap(),
        operation: "repository.read".into(),
        resource: "repo:acme/catalog".into(),
        audience: "https://api.github.com".into(),
        arguments: json!({}),
        idempotency_key: "lean-recovery".into(),
    };
    let frozen = freeze_intent(State(state.clone()), owner.clone(), Json(freeze));
    let frozen = body(frozen.await.unwrap()).await;
    let digest = frozen["intent_digest"].as_str().unwrap().to_owned();
    let invoke = InvokeTaskBody {
        intent_digest: digest.clone(),
    };
    let invoked = invoke_task(State(state.clone()), owner.clone(), Json(invoke));
    let invoked = body(invoked.await.unwrap()).await;
    let opening = invoked["intent_opening"]["opening"]
        .as_str()
        .unwrap()
        .to_owned();
    let receipt: InvocationReceipt = serde_json::from_value(invoked).unwrap();
    let exact = json!({"intent": frozen["intent"], "intent_digest": digest});
    let mut other_intent = exact.clone();
    other_intent["intent"]["nonce"] = json!("lean-other-nonce");
    let other: FrozenIntentV2 = serde_json::from_value(other_intent["intent"].clone()).unwrap();
    other_intent["intent_digest"] = json!(other.compute_digest().unwrap());
    let mut other_digest = exact.clone();
    other_digest["intent_digest"] = other_intent["intent_digest"].clone();
    let mut extra_field = exact.clone();
    extra_field["intent"]["unexpected"] = json!("ignored-field");
    let mut operator = HeaderMap::new();
    operator.insert(
        "x-opensesame-operator",
        state.operator_token.parse().unwrap(),
    );
    let stranger = session(&PrincipalId::new().to_string(), boot.org);
    let elsewhere = session(&subject, opensesame_domain::OrganizationId::new());
    let replace_receipt = |state: AppState, stored: InvocationReceipt| async move {
        sqlx::query("DELETE FROM receipts WHERE id = ?")
            .bind(stored.id.to_string())
            .execute(state.db.pool())
            .await
            .unwrap();
        state.db.insert_receipt(&stored).await.unwrap();
    };
    let path = std::env::var("OPENSESAME_INVOCATION_EFFECT_VECTORS").expect("Lean vector file");
    let mut cases = 0;
    for line in std::fs::read_to_string(path).unwrap().lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        let ["o2-recover", caller, request, authority, expected] = fields[..] else {
            continue;
        };
        let headers = match caller {
            "anonymous" => HeaderMap::new(),
            "owner" => owner.clone(),
            "operator" => operator.clone(),
            "other-principal" => stranger.clone(),
            "other-organization" => elsewhere.clone(),
            _ => panic!("invalid caller vector: {line}"),
        };
        let candidate = match request {
            "exact" => &exact,
            "other-digest" => &other_digest,
            "extra-field" => &extra_field,
            "other-intent" => &other_intent,
            _ => panic!("invalid request vector: {line}"),
        };
        let bootstrap_grant = || {
            state
                .bootstrap
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .grant
                .clone()
        };
        let original = bootstrap_grant();
        let mut signer = None;
        match authority {
            "intact" => {}
            "grant-changed" => {
                state
                    .bootstrap
                    .lock()
                    .unwrap()
                    .as_mut()
                    .unwrap()
                    .grant
                    .version += 1
            }
            "receipt-tampered" => {
                let mut tampered = receipt.clone();
                tampered.operation = "tampered".into();
                replace_receipt(state.clone(), tampered).await;
            }
            "signer-retired" => {
                let retired = opensesame_audit::ReceiptSigner::from_seed(&[42; 32]);
                let broker = Arc::get_mut(&mut state.broker).unwrap();
                signer = Some(std::mem::replace(&mut broker.signer, retired));
            }
            "grant-revoked" if original.revoked_at.is_none() => {
                let now = opensesame_time::Utc::now();
                state.db.revoke_grant(&boot.grant.id, now).await.unwrap();
            }
            "grant-revoked" => {}
            _ => panic!("invalid authority vector: {line}"),
        }
        let response = recover(&state, &headers, candidate).await;
        let status = response.status();
        let returned = body(response).await;
        let actual = match status {
            StatusCode::UNAUTHORIZED => "unauthorized",
            StatusCode::NOT_FOUND if returned == json!({"error": "not_found"}) => "not-found",
            StatusCode::OK if returned == json!({"opening": opening}) => "opening",
            _ => "other",
        };
        assert_eq!(actual, expected, "vector: {line}");
        assert!(
            actual == "opening" || !returned.to_string().contains(&opening),
            "vector: {line}"
        );
        // Restore every reversible change; revocation is replayed last.
        state.bootstrap.lock().unwrap().as_mut().unwrap().grant = original;
        if authority == "receipt-tampered" {
            replace_receipt(state.clone(), receipt.clone()).await;
        }
        if let Some(signer) = signer {
            Arc::get_mut(&mut state.broker).unwrap().signer = signer;
        }
        cases += 1;
    }
    assert_eq!(cases, 100, "vector: recovery case count");
    println!("invocation-formal: {cases} gateway recovery vectors matched");
}
