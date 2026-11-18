//! Caller and liveness scope for the relay.

use super::{AppState, HolderLiveness, Response, PRESENCE_FRESH_SECONDS};
use crate::middleware::auth::{require_demo_bootstrap, resolve_caller, Caller};

pub(super) fn caller_scope(
    st: &AppState,
    headers: &axum::http::HeaderMap,
) -> Result<(opensesame_domain::OrganizationId, String), Response> {
    match resolve_caller(st, headers)? {
        Caller::Session {
            organization_id,
            subject,
            ..
        } => Ok((organization_id, subject)),
        Caller::Operator => {
            let bootstrap = require_demo_bootstrap(st)?;
            Ok((bootstrap.org, bootstrap.principal.to_string()))
        }
    }
}

pub(super) fn holder_online(
    st: &AppState,
    organization: opensesame_domain::OrganizationId,
    holder: &str,
) -> HolderLiveness {
    let presence = st.relay_presence.lock().unwrap();
    match presence.get(&(organization, holder.to_owned())) {
        Some(seen) if seen.elapsed().as_secs() <= PRESENCE_FRESH_SECONDS => HolderLiveness::Online,
        _ => HolderLiveness::Offline,
    }
}
