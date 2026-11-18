//! Frozen invocation receipts preserve connector failure across replay.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use chrono::{Duration, Utc};
use opensesame_audit::ReceiptSigner;
use opensesame_authz::PolicyEngine;
use opensesame_connector_host::{Connector, HostError, HostRuntime, InvokeRequest, InvokeResult};
use opensesame_domain::{
    AuthorityContext, AuthorityContextId, AuthorityContextMode, Capability, CapabilitySet,
    CeilingInput, OrganizationId, PrincipalId, ReceiptOutcome, ResourceSelector, TaskTemplateId,
};
use opensesame_storage::Db;
use opensesame_task_access::{InMemoryTaskStore, StartTaskParams, TaskAccessEngine};
use serde_json::json;

use super::tests::{sample_grant, sample_intent};
use super::{Broker, FrozenInvokeInput};

struct FixedConnector {
    ok: bool,
    calls: Arc<AtomicUsize>,
}

impl Connector for FixedConnector {
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
        &["read"]
    }
    fn invoke(&self, _request: &InvokeRequest) -> Result<InvokeResult, HostError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(InvokeResult {
            ok: self.ok,
            safe_summary: json!({"result": "1-ssecca-ecar"}),
            external_request_digest: Some("1-ssecca-ecar".into()),
        })
    }
}

#[tokio::test]
async fn frozen_connector_outcome_is_signed_and_replayed_without_reexecution() {
    for ok in [false, true] {
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
        db.create_organization(&org, "frozen-outcome")
            .await
            .unwrap();
        let mut policy = PolicyEngine::default();
        policy
            .relationships
            .write("connection:demo-conn", "user", "user:demo");
        let calls = Arc::new(AtomicUsize::new(0));
        let mut host = HostRuntime::default();
        host.policy
            .trusted_digests
            .insert("sha256:outcome-fixture".into());
        host.register_connector(Arc::new(FixedConnector {
            ok,
            calls: Arc::clone(&calls),
        }))
        .unwrap();
        host.bind_connection("demo-conn", "outcome-fixture")
            .unwrap();
        let broker = Broker {
            db,
            policy,
            host,
            signer: ReceiptSigner::generate(),
        };
        let grant = sample_grant(org, principal);
        let input = || FrozenInvokeInput {
            intent: intent.clone(),
            grant: grant.clone(),
            subject: "user:demo".into(),
            connection_policy_id: "demo-conn".into(),
            required_capability: Capability::new("read", ResourceSelector::exact("doc:1")),
            lineage: None,
        };

        let receipt = broker.invoke_frozen(&tasks, input()).await.unwrap();
        assert_eq!(receipt.outcome, ReceiptOutcome::Indeterminate);
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
        let replay = broker.invoke_frozen(&tasks, input()).await.unwrap();
        assert_eq!(replay.id, receipt.id);
        assert_eq!(replay.outcome, ReceiptOutcome::Indeterminate);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
