//! Context reaches the real execution seam but cannot authorize delegation.

use super::*;
use opensesame_connector_host::{HostError, InvokeResult};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

#[tokio::test]
async fn independent_executor_receives_the_persisted_invocation_and_replay_skips_it() {
    let (broker, org, principal, actor) = setup().await;
    let parameters = json!({"query":"one"});
    let mut intent = sample_intent(
        org,
        principal,
        actor,
        "repository.read",
        "bound",
        &parameters,
    );
    let connection = ConnectionId::new();
    intent.connection_id = Some(connection);
    let mut grant = sample_grant(org, principal);
    grant.connection_id = Some(connection);
    let digest = intent.digest().unwrap();
    let intent_id = intent.id;
    let grant_id = grant.id;
    let input = || InvokeInput {
        intent: intent.clone(),
        grant: grant.clone(),
        subject: "user:demo".into(),
        connection_policy_id: "demo-conn".into(),
        parameters: parameters.clone(),
        lineage: None,
    };
    let seen = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&seen);
    let receipt = broker
        .invoke_with_bound(input(), move |binding| async move {
            assert_eq!(binding.organization_id(), org);
            assert_eq!(binding.principal_id(), principal);
            assert_eq!(binding.actor_id(), actor);
            assert_eq!(binding.connection_id(), Some(connection));
            assert_eq!(binding.connection_policy_id(), "demo-conn");
            assert_eq!(binding.intent_id(), intent_id);
            assert_eq!(binding.intent_digest(), digest);
            assert_eq!(binding.grant().id, grant_id);
            assert!(!binding.is_delegated());
            captured.lock().unwrap().push(binding.invocation_id());
            Ok(InvokeResult {
                ok: true,
                safe_summary: json!({}),
                external_request_digest: None,
            })
        })
        .await
        .unwrap();
    assert_eq!(*seen.lock().unwrap(), vec![receipt.invocation_id]);
    let later = Arc::clone(&seen);
    let replay = broker
        .invoke_with_bound(input(), move |binding| async move {
            later.lock().unwrap().push(binding.invocation_id());
            Err(HostError::Connector("replay executed".into()))
        })
        .await
        .unwrap();
    assert_eq!(replay.id, receipt.id);
    assert_eq!(*seen.lock().unwrap(), vec![receipt.invocation_id]);
}

#[tokio::test]
async fn independent_delegate_executor_is_refused_even_after_policy_allows_it() {
    let (broker, org, principal, actor) = setup().await;
    let parameters = json!({});
    let mut intent = sample_intent(
        org,
        principal,
        actor,
        "repository.read",
        "delegate-bound",
        &parameters,
    );
    let connection = ConnectionId::new();
    intent.connection_id = Some(connection);
    let mut root = sample_grant(org, principal);
    root.connection_id = Some(connection);
    root.constraints.maximum_delegation_depth = 1;
    let mut child = root.clone();
    child.id = GrantId::new();
    child.parent_grant_id = Some(root.id);
    child.delegation_depth = 1;
    child.constraints.maximum_delegation_depth = 0;
    intent.delegation_chain = vec![root.id, child.id];
    let lineage = ValidatedGrantChain::try_validate(&[root, child.clone()], Utc::now(), 0).unwrap();
    let input = InvokeInput {
        intent,
        grant: child,
        subject: "user:demo".into(),
        connection_policy_id: "demo-conn".into(),
        parameters,
        lineage: Some(lineage),
    };
    let intent_id = input.intent.id;
    let idempotency_key = input.intent.idempotency_key.clone();
    let count = Arc::new(AtomicUsize::new(0));
    let effects = Arc::clone(&count);
    let error = broker
        .invoke_with_bound(input, move |_| async move {
            effects.fetch_add(1, Ordering::SeqCst);
            Ok(InvokeResult {
                ok: true,
                safe_summary: json!({}),
                external_request_digest: None,
            })
        })
        .await
        .unwrap_err();
    assert_eq!(
        error.downcast_ref::<HostError>(),
        Some(&HostError::DelegatedExecutionUnavailable)
    );
    assert!(!error.to_string().contains("Indeterminate"));
    assert_eq!(count.load(Ordering::SeqCst), 0);
    assert_eq!(broker.db.count_receipts().await.unwrap(), 0);
    assert_eq!(
        broker
            .db
            .count_invocations_for_intent(&intent_id)
            .await
            .unwrap(),
        0
    );
    assert!(broker
        .db
        .find_idempotent_intent(&org, &idempotency_key)
        .await
        .unwrap()
        .is_none());
}

struct RecordingConnector(Arc<Mutex<Vec<(InvocationId, String, Option<ConnectionId>)>>>);
impl opensesame_connector_host::Connector for RecordingConnector {
    fn id(&self) -> &str {
        "recording"
    }
    fn version(&self) -> &str {
        "1"
    }
    fn component_digest(&self) -> &str {
        "sha256:recording"
    }
    fn operations(&self) -> &[&str] {
        &["repository.read"]
    }
    fn invoke(
        &self,
        _request: &opensesame_connector_host::InvokeRequest,
    ) -> Result<InvokeResult, HostError> {
        Err(HostError::Connector("unbound dispatch".into()))
    }
    fn invoke_bound(
        &self,
        request: &opensesame_connector_host::InvokeRequest,
        binding: &opensesame_connector_host::InvocationBinding,
    ) -> Result<InvokeResult, HostError> {
        binding.assert_request(binding.connection_policy_id(), request)?;
        self.0.lock().unwrap().push((
            binding.invocation_id(),
            binding.intent_digest().to_owned(),
            binding.connection_id(),
        ));
        Ok(InvokeResult {
            ok: true,
            safe_summary: json!({}),
            external_request_digest: None,
        })
    }
}

#[tokio::test]
async fn host_connector_receives_the_persisted_invocation_context() {
    let (mut broker, org, principal, actor) = setup().await;
    let seen = Arc::new(Mutex::new(Vec::new()));
    broker
        .host
        .policy
        .trusted_digests
        .insert("sha256:recording".into());
    broker
        .host
        .register_connector(Arc::new(RecordingConnector(Arc::clone(&seen))))
        .unwrap();
    broker
        .host
        .bind_connection("demo-conn", "recording")
        .unwrap();
    let parameters = json!({"query":"host"});
    let mut intent = sample_intent(
        org,
        principal,
        actor,
        "repository.read",
        "host-binding",
        &parameters,
    );
    let connection = ConnectionId::new();
    intent.connection_id = Some(connection);
    let intent_digest = intent.digest().unwrap();
    let mut grant = sample_grant(org, principal);
    grant.connection_id = Some(connection);
    let receipt = broker
        .invoke(InvokeInput {
            intent,
            grant,
            subject: "user:demo".into(),
            connection_policy_id: "demo-conn".into(),
            parameters,
            lineage: None,
        })
        .await
        .unwrap();
    assert_eq!(
        *seen.lock().unwrap(),
        vec![(receipt.invocation_id, intent_digest, Some(connection))]
    );
}
