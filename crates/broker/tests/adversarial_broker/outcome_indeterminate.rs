//! An independent executor's outcome disclosure is the host's call.

use super::*;
use opensesame_connector_host::{HostError, InvokeResult};
use std::sync::Arc;

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

/// Provider-controlled bytes that must never reach a signed receipt.
const MARKER: &str = "provider-marker-1-ssecca-ecar";

struct ProviderConnector(&'static str);

impl opensesame_connector_host::Connector for ProviderConnector {
    fn id(&self) -> &str {
        "provider-fixture"
    }
    fn version(&self) -> &str {
        "1"
    }
    fn component_digest(&self) -> &str {
        "sha256:provider-fixture"
    }
    fn operations(&self) -> &[&str] {
        &["repository.read"]
    }
    fn invoke(
        &self,
        _request: &opensesame_connector_host::InvokeRequest,
    ) -> Result<InvokeResult, HostError> {
        provider_result(self.0)
    }
}

fn provider_result(provider: &str) -> Result<InvokeResult, HostError> {
    match provider {
        "error" => Err(HostError::Connector(MARKER.into())),
        _ => Ok(InvokeResult {
            ok: provider == "ok",
            safe_summary: json!({"result": MARKER}),
            external_request_digest: Some(MARKER.into()),
        }),
    }
}

async fn o1_receipt(
    line: &str,
    path: &str,
    connector: &str,
    provider: &'static str,
) -> InvocationReceipt {
    let (mut broker, org, principal, actor) = setup().await;
    broker
        .host
        .policy
        .trusted_digests
        .insert("sha256:provider-fixture".into());
    broker
        .host
        .register_connector(Arc::new(ProviderConnector(provider)))
        .unwrap();
    broker
        .host
        .bind_connection("provider-conn", "provider-fixture")
        .unwrap();
    broker
        .policy
        .relationships
        .write("connection:provider-conn", "user", "user:demo");
    let conn = if connector == "host-mock" {
        "demo-conn"
    } else {
        "provider-conn"
    };
    // The host mock has no `ok = false` operation; its failure is an error.
    let operation = if path == "invoke" && connector == "host-mock" && provider == "error" {
        "error.transient"
    } else {
        "repository.read"
    };
    let params = json!({});
    let mut grant = sample_grant(org, principal);
    grant.actions.push(operation.into());
    let input = InvokeInput {
        intent: sample_intent(org, principal, actor, operation, "o1", &params),
        grant,
        subject: "user:demo".into(),
        connection_policy_id: conn.into(),
        parameters: params,
        lineage: None,
    };
    let receipt = match path {
        "invoke" => broker.invoke(input).await,
        "independent" => {
            broker
                .invoke_with_bound(input, move |_| async move { provider_result(provider) })
                .await
        }
        _ => panic!("vector: unknown path: {line}"),
    }
    .unwrap_or_else(|error| panic!("vector: {line}: {error}"));
    broker.signer.verify_receipt(&receipt).unwrap();
    receipt
}

fn outcome_name(outcome: ReceiptOutcome) -> &'static str {
    match outcome {
        ReceiptOutcome::Succeeded => "succeeded",
        ReceiptOutcome::Failed => "failed",
        ReceiptOutcome::Indeterminate => "indeterminate",
        ReceiptOutcome::Denied | ReceiptOutcome::Cancelled => "unexpected",
    }
}

fn provider_fields(line: &str, receipt: &InvocationReceipt) -> String {
    let rendered = serde_json::to_string(receipt).unwrap();
    for leaked in [MARKER, "sha256:mock-read", "README"] {
        assert!(
            !rendered.contains(leaked),
            "vector: {line}: receipt carries {leaked}"
        );
    }
    [
        receipt.safe_result_summary.is_some(),
        receipt.external_request_digest.is_some(),
        receipt.external_response_digest.is_some(),
    ]
    .map(|present| if present { '1' } else { '0' })
    .iter()
    .collect()
}

fn o2_receipt(schema: &str, leak: &str, signer: &ReceiptSigner) -> InvocationReceipt {
    let (org, principal) = (OrganizationId::new(), PrincipalId::new());
    let intent = sample_intent(
        org,
        principal,
        ActorId::new(),
        "repository.read",
        "o2",
        &json!({}),
    );
    let invocation_id = InvocationId::new();
    let digest = format!("sha256:{}", "c".repeat(64));
    let mut receipt = InvocationReceipt {
        id: ReceiptId::new(),
        invocation_id,
        intent_digest: signer.intent_commitment(&invocation_id, &digest).unwrap(),
        idempotency_binding: Some(signer.idempotency_commitment("o2")),
        principal_id: principal,
        organization_id: Some(org),
        actor_id: intent.actor_id,
        actor_instance_id: None,
        client_id: None,
        operator_id: None,
        delegation_chain: vec![],
        connection_id: None,
        operation: intent.operation,
        resource: intent.resource,
        policy_decision_id: "decision".into(),
        policy_version_digest: "policy".into(),
        approval_id: None,
        credential_handle_id: None,
        connector_component_digest: None,
        external_request_digest: None,
        external_response_digest: None,
        started_at: Utc::now(),
        completed_at: Utc::now(),
        outcome: ReceiptOutcome::Indeterminate,
        safe_result_summary: None,
        authority_key_id: String::new(),
        signature: String::new(),
        receipt_schema_version: if schema == "opaque" {
            OPAQUE_RESULT_RECEIPT_SCHEMA_VERSION
        } else {
            3
        },
        task_run_id: None,
        task_state_version: None,
        task_state_digest: None,
    };
    match leak {
        "summary" => receipt.safe_result_summary = Some(json!({"note": MARKER})),
        "request-digest" => receipt.external_request_digest = Some(MARKER.into()),
        "response-digest" => receipt.external_response_digest = Some(MARKER.into()),
        "plain-digest" => receipt.intent_digest = MARKER.into(),
        _ => {}
    }
    receipt
}

fn o2_open(line: &str, fields: &[&str]) -> String {
    let [schema, leak, key, tampered, _] = fields[..] else {
        panic!("vector: invalid: {line}")
    };
    let (active, other) = (ReceiptSigner::generate(), ReceiptSigner::generate());
    let signer = if key == "active" { &active } else { &other };
    let Ok(mut receipt) = signer.sign_receipt(o2_receipt(schema, leak, signer)) else {
        return "refused".into();
    };
    if tampered == "1" {
        receipt.operation = "tampered".into();
    }
    let Ok(opening) = active.open_receipt_intent(&receipt) else {
        return "0".into();
    };
    let original = format!("sha256:{}", "c".repeat(64));
    assert!(
        receipt.verifies_intent_opening(&opening, &original),
        "vector: {line}"
    );
    assert!(!receipt.verifies_intent_opening(&opening, &format!("sha256:{}", "d".repeat(64))));
    "1".into()
}

fn o2_check(line: &str, fields: &[&str]) -> String {
    let [schema, opening, digest, _] = fields[..] else {
        panic!("vector: invalid: {line}")
    };
    let own = format!("hmac-sha256:v1:{}", "a".repeat(64));
    let original = format!("sha256:{}", "c".repeat(64));
    let mut receipt = o2_receipt(schema, "none", &ReceiptSigner::generate());
    receipt.intent_digest = receipt_intent_commitment(&own, &original).unwrap();
    let opening = match opening {
        "own" => own,
        "other-invocation" => format!("hmac-sha256:v1:{}", "b".repeat(64)),
        _ => "hmac-sha256:v1:short".into(),
    };
    let digest = match digest {
        "original" => original,
        "other" => format!("sha256:{}", "d".repeat(64)),
        _ => "sha256:SHORT".into(),
    };
    u8::from(receipt.verifies_intent_opening(&opening, &digest)).to_string()
}

#[tokio::test]
#[ignore = "run by spec/formal/invocation/verify.sh with Lean vectors"]
async fn lean_receipt_vectors_match_the_broker() {
    let path = std::env::var("OPENSESAME_INVOCATION_EFFECT_VECTORS").expect("Lean vector file");
    let mut count = 0;
    for line in std::fs::read_to_string(path).unwrap().lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        let (actual, expected) = match fields[..] {
            ["o1", "frozen", ..] => continue,
            ["o1", path, connector, provider, outcome, provider_fields_expected] => {
                let provider = match provider {
                    "ok" => "ok",
                    "not-ok" => "not-ok",
                    _ => "error",
                };
                let receipt = o1_receipt(line, path, connector, provider).await;
                let fields = provider_fields(line, &receipt);
                assert_eq!(fields, provider_fields_expected, "vector: {line}");
                (outcome_name(receipt.outcome).to_owned(), outcome)
            }
            ["o2", ref rest @ ..] => (o2_open(line, rest), fields[5]),
            ["o2-opening", ref rest @ ..] => (o2_check(line, rest), fields[4]),
            _ => continue,
        };
        assert_eq!(actual, expected, "vector: {line}");
        count += 1;
    }
    assert!(count > 0, "no o1/o2 vectors");
    println!("invocation-formal: {count} o1/o2 vectors matched");
}
