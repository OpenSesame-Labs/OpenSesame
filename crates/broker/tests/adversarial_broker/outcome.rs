//! Exercise connector outcomes through the authorized broker and replay.

use super::*;
use opensesame_connector_host::{HostError, InvokeResult};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

#[tokio::test]
async fn connector_failure_is_signed_and_replayed_as_failure() {
    for (ok, expected) in [
        (false, ReceiptOutcome::Failed),
        (true, ReceiptOutcome::Succeeded),
    ] {
        let (broker, org, principal, actor) = setup().await;
        let params = json!({});
        let intent = sample_intent(org, principal, actor, "repository.read", "outcome", &params);
        let grant = sample_grant(org, principal);
        let input = || InvokeInput {
            intent: intent.clone(),
            grant: grant.clone(),
            subject: "user:demo".into(),
            connection_policy_id: "demo-conn".into(),
            parameters: params.clone(),
            lineage: None,
        };
        let calls = Arc::new(AtomicUsize::new(0));
        let first_calls = Arc::clone(&calls);
        let receipt = broker
            .invoke_with(input(), move || async move {
                first_calls.fetch_add(1, Ordering::SeqCst);
                Ok::<_, HostError>(InvokeResult {
                    ok,
                    safe_summary: json!({"result": "provider complete"}),
                    external_request_digest: Some("sha256:fixture".into()),
                })
            })
            .await
            .unwrap();
        assert_eq!(receipt.outcome, expected);
        assert_eq!(
            receipt.safe_result_summary,
            Some(json!({"result": "provider complete"}))
        );
        assert_eq!(
            receipt.external_request_digest.as_deref(),
            Some("sha256:fixture")
        );
        broker.signer.verify_receipt(&receipt).unwrap();

        let replay_calls = Arc::clone(&calls);
        let replay = broker
            .invoke_with(input(), move || async move {
                replay_calls.fetch_add(1, Ordering::SeqCst);
                Ok::<_, HostError>(InvokeResult {
                    ok: !ok,
                    safe_summary: json!({"unexpected": true}),
                    external_request_digest: None,
                })
            })
            .await
            .unwrap();
        assert_eq!(replay.id, receipt.id);
        assert_eq!(replay.outcome, expected);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn failed_settlement_does_not_reexecute_an_indeterminate_effect() {
    let path = std::env::temp_dir().join(format!(
        "opensesame-invocation-settlement-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let url = opensesame_storage::sqlite_file_url(&path);
    let (mut broker, org, principal, actor) = setup().await;
    broker.db = Db::connect_sqlite(&url).await.unwrap();
    broker
        .db
        .create_organization(&org, "outcome")
        .await
        .unwrap();
    let params = json!({});
    let intent = sample_intent(
        org,
        principal,
        actor,
        "repository.read",
        "indeterminate",
        &params,
    );
    let grant = sample_grant(org, principal);
    let input = || InvokeInput {
        intent: intent.clone(),
        grant: grant.clone(),
        subject: "user:demo".into(),
        connection_policy_id: "demo-conn".into(),
        parameters: params.clone(),
        lineage: None,
    };
    let effects = Arc::new(AtomicUsize::new(0));
    let first_effects = Arc::clone(&effects);
    let failing_db = broker.db.clone();
    let first = broker
        .invoke_with(input(), move || async move {
            first_effects.fetch_add(1, Ordering::SeqCst);
            // Simulate losing durable storage after a provider side effect.
            failing_db.pool().close().await;
            Ok::<_, HostError>(InvokeResult {
                ok: true,
                safe_summary: json!({"result": "provider complete"}),
                external_request_digest: None,
            })
        })
        .await;
    assert!(first.is_err());
    assert_eq!(effects.load(Ordering::SeqCst), 1);

    // Reopen the same durable reservation. It has no receipt and must not
    // invoke the provider again, even though the earlier effect is unknown.
    broker.db = Db::connect_sqlite(&url).await.unwrap();
    assert_eq!(broker.db.count_receipts().await.unwrap(), 0);
    assert_eq!(
        broker
            .db
            .count_invocations_for_intent(&intent.id)
            .await
            .unwrap(),
        1
    );
    let retry_effects = Arc::clone(&effects);
    let retry = broker
        .invoke_with(input(), move || async move {
            retry_effects.fetch_add(1, Ordering::SeqCst);
            Ok::<_, HostError>(InvokeResult {
                ok: true,
                safe_summary: json!({}),
                external_request_digest: None,
            })
        })
        .await;
    assert!(retry
        .unwrap_err()
        .to_string()
        .contains("prior intent has no receipt"));
    assert_eq!(effects.load(Ordering::SeqCst), 1);
    broker.db.pool().close().await;
    std::fs::remove_file(path).unwrap();
}
