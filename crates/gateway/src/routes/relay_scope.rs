//! Caller scope for the relay.

use super::{AppState, Response};
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
