//! Bootstrap invocations may exercise only a root grant.

use super::*;

pub(super) fn bootstrap_invocation(
    st: &AppState,
    boot: &crate::app_state::Bootstrap,
) -> Result<ResolvedInvocation, Response> {
    if boot.grant.parent_grant_id.is_some() || boot.grant.delegation_depth != 0 {
        return Err(super::intents_queue::delegated_execution_unavailable());
    }
    let Some(connection_ref) = st.connection_ref.clone() else {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"bootstrap_unavailable"})),
        )
            .into_response());
    };
    Ok(ResolvedInvocation {
        grant: boot.grant.clone(),
        lineage: None,
        delegation_chain: vec![boot.grant.id],
        connection_id: boot.connection,
        principal_id: boot.principal,
        binding: opensesame_authz::github_binding(connection_ref, "github/main"),
        connection_policy_id: bootstrap_connection_policy_id(),
        spend_budget: None,
        broker_connection: false,
    })
}

/// Connection policy id for bootstrap task execution (frozen invoke, opening recovery).
pub(super) fn bootstrap_connection_policy_id() -> String {
    // Demo bootstrap wires the inert mock connector; delegated paths use broker resolution.
    "demo-conn".into()
}

pub(crate) fn bootstrap_connection_policy_for(
    st: &AppState,
    boot: &crate::app_state::Bootstrap,
) -> Result<String, Response> {
    Ok(bootstrap_invocation(st, boot)?.connection_policy_id)
}
