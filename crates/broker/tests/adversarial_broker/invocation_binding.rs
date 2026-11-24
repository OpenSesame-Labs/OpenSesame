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

/// What the connector observed per call: invocation, action and connection.
type Seen = Vec<(InvocationId, String, Option<ConnectionId>)>;

struct RecordingConnector(Arc<Mutex<Seen>>);
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

/// The refusal `invoke_inner` reports, named as the Lean model names it.
fn conflict_reason(message: &str) -> &'static str {
    [
        ("different or missing binding", "conflict:binding"),
        ("has no receipt yet", "conflict:no-receipt"),
        ("not safely disclosable", "conflict:unsafe-receipt"),
        ("current authorization denied", "conflict:denied"),
        ("no prior invocation to replay", "conflict:no-prior"),
    ]
    .into_iter()
    .find_map(|(needle, name)| message.contains(needle).then_some(name))
    .unwrap_or("conflict:other")
}

/// Invoke once, then store the receipt as the vector's `kind` describes it.
async fn store_prior_receipt(broker: &Broker, request: InvokeInput, kind: &str) -> ReceiptId {
    let receipt = broker.invoke(request).await.unwrap();
    let mut stored = receipt.clone();
    match kind {
        "valid" => return receipt.id,
        "bad-signature" => stored.operation = "forged".into(),
        "other-intent" => stored.intent_digest = format!("sha256:{}", "1".repeat(64)),
        "other-binding" => stored.idempotency_binding = Some("other".into()),
        // Schema 6 cannot be signed with a result; a legacy receipt can.
        "not-opaque" => {
            stored.receipt_schema_version = 5;
            stored.safe_result_summary = Some(json!({"n": 1}));
        }
        _ => panic!("invalid receipt vector: {kind}"),
    }
    if kind != "bad-signature" {
        stored = broker.signer.sign_receipt(stored).unwrap();
    }
    sqlx::query("DELETE FROM receipts WHERE id = ?")
        .bind(receipt.id.to_string())
        .execute(broker.db.pool())
        .await
        .unwrap();
    broker.db.insert_receipt(&stored).await.unwrap();
    receipt.id
}

/// INV-I1: every Lean case from `spec/formal/invocation` against the real broker.
#[tokio::test]
#[ignore = "run by verify:invocation-formal with OPENSESAME_INVOCATION_VECTORS"]
async fn lean_retry_vectors_match_the_broker() {
    let path = std::env::var("OPENSESAME_INVOCATION_VECTORS").expect("Lean vector file");
    let mut seen = std::collections::HashSet::new();
    for line in std::fs::read_to_string(path).unwrap().lines() {
        assert!(seen.insert(line.to_owned()), "duplicate vector: {line}");
        let fields: Vec<&str> = line.split('\t').collect();
        let [mode, stored, kind, allows, expected] = fields[..] else {
            panic!("invalid vector: {line}")
        };
        let (mut broker, org, principal, actor) = setup().await;
        let grant = sample_grant(org, principal);
        let parameters = json!({});
        let intent = sample_intent(
            org,
            principal,
            actor,
            "repository.read",
            "lean",
            &parameters,
        );
        let request = || InvokeInput {
            intent: intent.clone(),
            grant: grant.clone(),
            subject: "user:demo".into(),
            connection_policy_id: "demo-conn".into(),
            parameters: parameters.clone(),
            lineage: None,
        };
        let mut first = None;
        match (stored, kind) {
            ("none", "none") => {}
            ("unbound", "none") => broker.db.insert_intent(&intent).await.unwrap(),
            ("other-binding", "none") => {
                let mut other = request();
                other.subject = "user:other".into();
                broker.invoke(other).await.unwrap();
            }
            ("same-binding", "none") => {
                let binding = opensesame_broker::invocation_fingerprint(&request()).unwrap();
                broker
                    .db
                    .insert_bound_intent(&intent, &binding)
                    .await
                    .unwrap();
            }
            ("same-binding", _) => {
                first = Some(store_prior_receipt(&broker, request(), kind).await);
            }
            _ => panic!("invalid stored vector: {line}"),
        }
        if allows == "0" {
            broker.policy.relationships = Default::default();
        }
        let before = broker
            .db
            .count_invocations_for_intent(&intent.id)
            .await
            .unwrap();
        let result = match mode {
            "invoke" => broker.invoke(request()).await,
            "replay" => broker.replay(request()).await,
            _ => panic!("invalid mode vector: {line}"),
        };
        let actual = match result {
            Err(error) => conflict_reason(&error.to_string()),
            Ok(receipt) if Some(receipt.id) == first => "prior",
            Ok(receipt) if receipt.outcome == ReceiptOutcome::Succeeded => "executed",
            Ok(receipt) if receipt.outcome == ReceiptOutcome::Denied => "denied",
            // Any other receipt (indeterminate, failed) is a mismatch.
            Ok(_) => "other",
        };
        assert_eq!(actual, expected, "vector: {line}");
        let after = broker
            .db
            .count_invocations_for_intent(&intent.id)
            .await
            .unwrap();
        if actual == "prior" || actual.starts_with("conflict") {
            assert_eq!(before, after, "a retry started an invocation: {line}");
        }
    }
    assert_eq!(seen.len(), 36, "incomplete Lean retry matrix");
    println!(
        "invocation retry correspondence: {} cases passed",
        seen.len()
    );
}
