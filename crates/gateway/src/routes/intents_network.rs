//! Dispatch of already-admitted owner requests and receipt-only replay.

use super::*;
use opensesame_connector_host::{HostError, InvokeResult};
use opensesame_domain::InvocationReceipt;

pub(super) async fn execute_invocation(
    st: &AppState,
    organization_id: OrganizationId,
    resolved: &ResolvedInvocation,
    input: InvokeInput,
    constrained_http: Option<ConstrainedHttpInput>,
    replay_only: bool,
) -> anyhow::Result<InvocationReceipt> {
    if replay_only {
        return st.broker.replay(input).await;
    }
    let Some(network) = constrained_http else {
        return st.broker.invoke(input).await;
    };
    let broker = st.connection_broker.clone();
    let durable_connection_id = resolved.connection_id;
    let connection_id = resolved.connection_id.to_string();
    let operation = input.intent.operation.clone();
    st.broker
        .invoke_with_bound(input, |binding| async move {
            if binding.is_delegated()
                || binding.organization_id() != organization_id
                || binding.connection_id() != Some(durable_connection_id)
                || binding.operation() != operation
            {
                return Err(HostError::InvocationBindingMismatch);
            }
            broker
                .invoke_network_json(
                    &organization_id,
                    &connection_id,
                    &operation,
                    &network.method,
                    &network.url,
                    network.body,
                )
                .await
                .map(|_| InvokeResult {
                    ok: true,
                    safe_summary: json!({"result":"completed"}),
                    external_request_digest: None,
                })
                .map_err(|error| HostError::Connector(error.to_string()))
        })
        .await
}
