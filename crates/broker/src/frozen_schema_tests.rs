//! The frozen-intent schema version gate refuses before any state is read.

use super::tests::{sample_grant, sample_intent};
use super::*;
use opensesame_audit::ReceiptSigner;
use opensesame_authz::PolicyEngine;
use opensesame_connector_host::HostRuntime;
use opensesame_domain::{OrganizationId, PrincipalId, FROZEN_INTENT_SCHEMA_VERSION};
use opensesame_storage::Db;
use opensesame_task_access::InMemoryTaskStore;

#[tokio::test]
async fn an_unknown_frozen_schema_version_is_refused_before_any_state_is_read() {
    let org = OrganizationId::new();
    let principal = PrincipalId::new();
    let db = Db::connect_memory().await.unwrap();
    db.create_organization(&org, "frozen-schema").await.unwrap();
    let mut policy = PolicyEngine::default();
    policy
        .relationships
        .write("connection:demo-conn", "user", "user:demo");
    let broker = Broker {
        db,
        policy,
        host: HostRuntime::default(),
        signer: ReceiptSigner::generate(),
    };
    let tasks = TaskAccessEngine::new(InMemoryTaskStore::new());
    // The digest is self-consistent (recomputed over the foreign schema
    // version); only the version gate can refuse it, and it must refuse
    // before any task, policy, or idempotency state is consulted.
    let mut foreign = sample_intent(org, principal);
    foreign.schema_version = FROZEN_INTENT_SCHEMA_VERSION + 1;
    let foreign = foreign.with_computed_digest().unwrap();
    assert!(foreign.assert_digest().is_ok());
    let input = || FrozenInvokeInput {
        intent: foreign.clone(),
        grant: sample_grant(org, principal),
        subject: "user:demo".into(),
        connection_policy_id: "demo-conn".into(),
        required_capability: Capability::new("read", ResourceSelector::exact("doc:1")),
        lineage: None,
    };
    for error in [
        broker
            .invoke_frozen(&tasks, input())
            .await
            .unwrap_err()
            .to_string(),
        broker
            .recover_frozen_receipt(&tasks, input())
            .await
            .unwrap_err()
            .to_string(),
    ] {
        assert_eq!(error, "unsupported frozen intent");
    }
    assert_eq!(broker.db.count_receipts().await.unwrap(), 0);
}
