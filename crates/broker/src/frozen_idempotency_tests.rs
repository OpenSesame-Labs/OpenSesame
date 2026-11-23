//! Frozen intent replay guards: a duplicated intent id under a fresh
//! idempotency key and any mutation after the freeze are rejected before the
//! connector runs again.

use super::tests::{sample_grant, sample_intent};
use super::*;
use opensesame_audit::ReceiptSigner;
use opensesame_authz::PolicyEngine;
use opensesame_connector_host::HostRuntime;
use opensesame_domain::{
    ActorId, AuthorityContext, AuthorityContextId, AuthorityContextMode, CapabilitySet,
    CeilingInput, IntentId, OrganizationId, PrincipalId, TaskTemplateId,
    FROZEN_INTENT_SCHEMA_VERSION,
};
use opensesame_storage::Db;
use opensesame_task_access::{InMemoryTaskStore, StartTaskParams};
use opensesame_time::Duration;

#[tokio::test]
async fn duplicate_intent_id_with_fresh_idempotency_key_never_reaches_the_connector() {
    let org = OrganizationId::new();
    let principal = PrincipalId::new();
    let capabilities = CapabilitySet::new(vec![Capability::new(
        "read",
        ResourceSelector::exact("doc:1"),
    )]);
    let tasks = TaskAccessEngine::new(InMemoryTaskStore::new());
    let ceiling = tasks
        .compile_ceiling(
            vec![CeilingInput {
                principal_id: principal,
                capabilities: capabilities.clone(),
            }],
            Utc::now(),
        )
        .unwrap();
    let run = tasks
        .start_task(StartTaskParams {
            template_id: TaskTemplateId::new(),
            authority_context: AuthorityContext {
                id: AuthorityContextId::new(),
                mode: AuthorityContextMode::SinglePrincipal,
                organization_id: org,
                project_id: None,
                principal_ids: vec![principal],
                capability_ceiling: capabilities,
                compiled_at: Utc::now(),
            },
            ceiling,
            maximum_expires_at: Utc::now() + Duration::hours(1),
            now: Utc::now(),
        })
        .unwrap();
    let mut intent = sample_intent(org, principal);
    intent.task_run_id = run.id;
    intent.task_state_version = run.state_version;
    intent.task_state_digest = run.state_digest;
    let intent = intent.with_computed_digest().unwrap();

    let db = Db::connect_memory().await.unwrap();
    db.create_organization(&org, "frozen").await.unwrap();
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
    let grant = sample_grant(org, principal);
    let invoke = |intent: &FrozenIntentV2| FrozenInvokeInput {
        intent: intent.clone(),
        grant: grant.clone(),
        subject: "user:demo".into(),
        connection_policy_id: "demo-conn".into(),
        required_capability: Capability::new("read", ResourceSelector::exact("doc:1")),
        lineage: None,
    };

    let first = broker.invoke_frozen(&tasks, invoke(&intent)).await.unwrap();
    assert_eq!(broker.db.count_receipts().await.unwrap(), 1);

    // Adversary: replay the same frozen intent id under a different
    // idempotency key, well-digest and authorized. The org+key lookup finds no
    // prior receipt, so only the intents.id primary key stands between this
    // and a second connector execution. `insert_bound_intent` runs before any
    // execution, so the duplicate fails there.
    let mut duplicate = intent.clone();
    duplicate.idempotency_key = "idem-second".into();
    duplicate.nonce = "n2".into();
    let duplicate = duplicate.with_computed_digest().unwrap();
    let error = broker
        .invoke_frozen(&tasks, invoke(&duplicate))
        .await
        .unwrap_err();
    assert!(
        !error.to_string().contains("current authorization denied"),
        "the duplicate must be rejected as a duplicate, not on policy: {error}"
    );
    // Exactly one invocation row and one receipt for the intent: the connector
    // never ran a second time, and the deterministic ReceiptId
    // (from_uuid(intent.id)) was never written twice.
    assert_eq!(
        broker
            .db
            .count_invocations_for_intent(&intent.id)
            .await
            .unwrap(),
        1
    );
    assert_eq!(broker.db.count_receipts().await.unwrap(), 1);
    // The original receipt is still the only one and still replays cleanly.
    let replay = broker.invoke_frozen(&tasks, invoke(&intent)).await.unwrap();
    assert_eq!(replay.id, first.id);
}

#[tokio::test]
async fn mutation_after_freeze_rejected_by_digest() {
    let caps = CapabilitySet::new(vec![Capability::new(
        "read",
        ResourceSelector::exact("doc:1"),
    )]);
    let org = OrganizationId::new();
    let principal = PrincipalId::new();
    let ctx = AuthorityContext {
        id: AuthorityContextId::new(),
        mode: AuthorityContextMode::SinglePrincipal,
        organization_id: org,
        project_id: None,
        principal_ids: vec![principal],
        capability_ceiling: caps.clone(),
        compiled_at: Utc::now(),
    };
    let engine = TaskAccessEngine::new(InMemoryTaskStore::new());
    let ceiling = engine
        .compile_ceiling(
            vec![CeilingInput {
                principal_id: principal,
                capabilities: caps.clone(),
            }],
            Utc::now(),
        )
        .unwrap();
    let run = engine
        .start_task(StartTaskParams {
            template_id: TaskTemplateId::new(),
            authority_context: ctx,
            ceiling,
            maximum_expires_at: Utc::now() + Duration::hours(1),
            now: Utc::now(),
        })
        .unwrap();

    let mut intent = FrozenIntentV2 {
        schema_version: FROZEN_INTENT_SCHEMA_VERSION,
        id: IntentId::new(),
        task_run_id: run.id,
        task_state_version: run.state_version,
        task_state_digest: run.state_digest.clone(),
        organization_id: org,
        project_id: None,
        principal_id: principal,
        actor_id: ActorId::new(),
        actor_instance_id: None,
        client_id: None,
        operator_id: None,
        connection_id: None,
        operation: "read".into(),
        resource: "doc:1".into(),
        audience: "https://rs.example".into(),
        canonical_arguments: json!({"tenant": "A"}),
        body_hash: None,
        nonce: "n1".into(),
        idempotency_key: "idem-mut".into(),
        issued_at: Utc::now(),
        expires_at: Utc::now() + Duration::minutes(5),
        intent_digest: String::new(),
    }
    .with_computed_digest()
    .unwrap();

    let authorized_digest = intent.intent_digest.clone();
    // Mutate after authorization snapshot — digest must fail.
    intent.canonical_arguments = json!({"tenant": "B"});
    assert!(intent.assert_digest().is_err());
    assert_ne!(intent.compute_digest().unwrap(), authorized_digest);
    let _ = sample_grant(org, principal);
}
