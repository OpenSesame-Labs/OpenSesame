//! Exercise connector outcomes through the authorized broker and replay.

use super::*;
use opensesame_connector_host::{HostError, InvokeResult};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

#[tokio::test]
async fn connector_failure_is_signed_and_replayed_as_failure() {
    for ok in [false, true] {
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
                    safe_summary: json!({"result": "1-ssecca-ecar"}),
                    external_request_digest: Some("1-ssecca-ecar".into()),
                })
            })
            .await
            .unwrap();
        // The independent executor runs on the inert mock's connection, which
        // is the one connection the host itself vouches for, so the outcome is
        // disclosed — never the result body.
        assert_eq!(
            receipt.outcome,
            if ok {
                ReceiptOutcome::Succeeded
            } else {
                ReceiptOutcome::Failed
            }
        );
        let state: String = sqlx::query_scalar("SELECT state FROM invocations WHERE id = ?")
            .bind(receipt.invocation_id.to_string())
            .fetch_one(broker.db.pool())
            .await
            .unwrap();
        assert_eq!(state, if ok { "succeeded" } else { "failed" });
        assert!(receipt.has_opaque_result());
        assert!(!serde_json::to_string(&receipt)
            .unwrap()
            .contains("1-ssecca-ecar"));
        broker.signer.verify_receipt(&receipt).unwrap();
        let stored = broker.db.get_receipt(&receipt.id).await.unwrap().unwrap();
        assert_eq!(stored.receipt, receipt);

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
        assert_eq!(
            replay.outcome,
            if ok {
                ReceiptOutcome::Succeeded
            } else {
                ReceiptOutcome::Failed
            }
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn connector_error_text_never_enters_the_receipt() {
    let (broker, org, principal, actor) = setup().await;
    let params = json!({});
    let intent = sample_intent(org, principal, actor, "repository.read", "error", &params);
    let receipt = broker
        .invoke_with(
            InvokeInput {
                intent,
                grant: sample_grant(org, principal),
                subject: "user:demo".into(),
                connection_policy_id: "demo-conn".into(),
                parameters: params,
                lineage: None,
            },
            || async { Err(HostError::Connector("1-ssecca-ecar".into())) },
        )
        .await
        .unwrap();
    // The executor failed on the mock's connection: a disclosed failure, but
    // the error text itself never enters the receipt.
    assert_eq!(receipt.outcome, ReceiptOutcome::Failed);
    assert!(receipt.has_opaque_result());
    assert!(!serde_json::to_string(&receipt)
        .unwrap()
        .contains("1-ssecca-ecar"));
    broker.signer.verify_receipt(&receipt).unwrap();
}

#[tokio::test]
async fn legacy_and_forged_receipts_are_not_replayed_or_executed_again() {
    let (broker, org, principal, actor) = setup().await;
    let params = json!({});
    let intent = sample_intent(org, principal, actor, "repository.read", "legacy", &params);
    let grant = sample_grant(org, principal);
    let input = || InvokeInput {
        intent: intent.clone(),
        grant: grant.clone(),
        subject: "user:demo".into(),
        connection_policy_id: "demo-conn".into(),
        parameters: params.clone(),
        lineage: None,
    };
    let original = broker.invoke(input()).await.unwrap();
    sqlx::query("DELETE FROM receipts WHERE id = ?")
        .bind(original.id.to_string())
        .execute(broker.db.pool())
        .await
        .unwrap();
    let mut legacy = original.clone();
    legacy.receipt_schema_version = 3;
    legacy.idempotency_binding = None;
    legacy.safe_result_summary = Some(json!({"result":"1-ssecca-ecar"}));
    let legacy = broker.signer.sign_receipt(legacy).unwrap();
    broker.db.insert_receipt(&legacy).await.unwrap();
    assert!(broker
        .replay(input())
        .await
        .unwrap_err()
        .to_string()
        .contains("not safely disclosable"));
    broker.signer.verify_receipt(&legacy).unwrap();
    assert_eq!(
        broker
            .db
            .count_invocations_for_intent(&intent.id)
            .await
            .unwrap(),
        1
    );

    // A storage attacker cannot make an old signed receipt safe merely by
    // changing the version and hiding its result: the signature must match.
    sqlx::query("DELETE FROM receipts WHERE id = ?")
        .bind(legacy.id.to_string())
        .execute(broker.db.pool())
        .await
        .unwrap();
    let mut forged = legacy;
    forged.receipt_schema_version = 6;
    forged.safe_result_summary = None;
    assert!(forged.has_opaque_result());
    broker.db.insert_receipt(&forged).await.unwrap();
    assert!(broker
        .replay(input())
        .await
        .unwrap_err()
        .to_string()
        .contains("not safely disclosable"));
    assert_eq!(
        broker
            .db
            .count_invocations_for_intent(&intent.id)
            .await
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn reparented_receipts_and_invocations_cannot_replay() {
    for swap_receipts in [true, false] {
        let (broker, org, principal, actor) = setup().await;
        let params = json!({});
        let grant = sample_grant(org, principal);
        let first = sample_intent(org, principal, actor, "repository.read", "first", &params);
        let second = sample_intent(org, principal, actor, "repository.read", "second", &params);
        let input = |intent: &Intent| InvokeInput {
            intent: intent.clone(),
            grant: grant.clone(),
            subject: "user:demo".into(),
            connection_policy_id: "demo-conn".into(),
            parameters: params.clone(),
            lineage: None,
        };
        let a = broker.invoke(input(&first)).await.unwrap();
        let b = broker.invoke(input(&second)).await.unwrap();
        if swap_receipts {
            for (receipt, invocation) in [(&a, &b), (&b, &a)] {
                sqlx::query("UPDATE receipts SET invocation_id = ? WHERE id = ?")
                    .bind(invocation.invocation_id.to_string())
                    .bind(receipt.id.to_string())
                    .execute(broker.db.pool())
                    .await
                    .unwrap();
            }
        } else {
            for (receipt, intent) in [(&a, &second), (&b, &first)] {
                sqlx::query("UPDATE invocations SET intent_id = ? WHERE id = ?")
                    .bind(intent.id.to_string())
                    .bind(receipt.invocation_id.to_string())
                    .execute(broker.db.pool())
                    .await
                    .unwrap();
            }
        }
        assert!(broker.replay(input(&first)).await.is_err());
        assert_eq!(
            broker
                .db
                .count_invocations_for_intent(&first.id)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            broker
                .db
                .count_invocations_for_intent(&second.id)
                .await
                .unwrap(),
            1
        );
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

#[tokio::test]
async fn signed_unkeyed_idempotency_binding_is_not_replayed() {
    let (broker, org, principal, actor) = setup().await;
    let params = json!({"private_choice":"small-domain"});
    let intent = sample_intent(org, principal, actor, "repository.read", "unkeyed", &params);
    let grant = sample_grant(org, principal);
    let input = || InvokeInput {
        intent: intent.clone(),
        grant: grant.clone(),
        subject: "user:demo".into(),
        connection_policy_id: "demo-conn".into(),
        parameters: params.clone(),
        lineage: None,
    };
    let fingerprint = opensesame_broker::invocation_fingerprint(&input()).unwrap();
    let receipt = broker.invoke(input()).await.unwrap();
    assert!(receipt
        .idempotency_binding
        .as_deref()
        .unwrap()
        .starts_with("hmac-sha256:v1:"));
    assert_ne!(
        receipt.idempotency_binding.as_deref(),
        Some(fingerprint.digest())
    );
    sqlx::query("DELETE FROM receipts WHERE id = ?")
        .bind(receipt.id.to_string())
        .execute(broker.db.pool())
        .await
        .unwrap();
    let mut legacy = receipt;
    legacy.idempotency_binding = Some(fingerprint.digest().to_owned());
    let legacy = broker.signer.sign_receipt(legacy).unwrap();
    broker.db.insert_receipt(&legacy).await.unwrap();
    assert!(broker.replay(input()).await.is_err());
    assert_eq!(
        broker
            .db
            .count_invocations_for_intent(&intent.id)
            .await
            .unwrap(),
        1
    );
}

/// Outcome disclosure is the host's call, not the executor's: a connection the
/// host does not vouch for (anything but the inert builtin mock) settles an
/// independent executor's receipt as indeterminate even on a clean success.
#[tokio::test]
async fn independent_executor_on_a_real_connection_stays_indeterminate() {
    let (mut broker, org, principal, actor) = setup().await;
    broker
        .host
        .policy
        .trusted_digests
        .insert("sha256:outcome-fixture".into());
    broker
        .host
        .register_connector(Arc::new(IndeterminateConnector))
        .unwrap();
    broker
        .host
        .bind_connection("real-conn", "outcome-fixture")
        .unwrap();
    broker
        .policy
        .relationships
        .write("connection:real-conn", "user", "user:demo");
    assert!(!broker.host.permits_outcome_disclosure("real-conn"));

    let params = json!({});
    let intent = sample_intent(
        org,
        principal,
        actor,
        "repository.read",
        "real-conn",
        &params,
    );
    let grant = sample_grant(org, principal);
    let receipt = broker
        .invoke_with_bound(
            InvokeInput {
                intent,
                grant,
                subject: "user:demo".into(),
                connection_policy_id: "real-conn".into(),
                parameters: params,
                lineage: None,
            },
            |_| async {
                Ok::<_, HostError>(InvokeResult {
                    ok: true,
                    safe_summary: json!({"result": "1-ssecca-ecar"}),
                    external_request_digest: None,
                })
            },
        )
        .await
        .unwrap();
    assert_eq!(receipt.outcome, ReceiptOutcome::Indeterminate);
    assert!(receipt.has_opaque_result());
    assert!(!serde_json::to_string(&receipt)
        .unwrap()
        .contains("1-ssecca-ecar"));
    let state: String = sqlx::query_scalar("SELECT state FROM invocations WHERE id = ?")
        .bind(receipt.invocation_id.to_string())
        .fetch_one(broker.db.pool())
        .await
        .unwrap();
    assert_eq!(state, "succeeded");
}

struct IndeterminateConnector;

impl opensesame_connector_host::Connector for IndeterminateConnector {
    fn id(&self) -> &str {
        "outcome-fixture"
    }
    fn version(&self) -> &str {
        "1"
    }
    fn component_digest(&self) -> &str {
        "sha256:outcome-fixture"
    }
    fn operations(&self) -> &[&str] {
        &["repository.read", "pull_request.create"]
    }
    fn invoke(
        &self,
        _request: &opensesame_connector_host::InvokeRequest,
    ) -> Result<InvokeResult, HostError> {
        Err(HostError::Connector("not invoked".into()))
    }
}
