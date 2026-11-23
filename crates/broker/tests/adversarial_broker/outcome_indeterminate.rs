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
