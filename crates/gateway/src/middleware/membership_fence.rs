//! Native sessions are process-local, but their Identity withdrawal fence is durable.
use crate::{app_state::AppState, middleware::auth::require_session, session_claims::CredentialKind};
use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};

pub async fn guard(State(st): State<AppState>, request: Request, next: Next) -> Response {
    let session = require_session(&st, request.headers()).ok();
    if let Some((digest, claims)) = session {
        let live = match claims.credential_kind {
            CredentialKind::NativeSession if claims.local_session => true,
            CredentialKind::NativeSession => {
                let revision = claims.membership_revision.as_ref()
                    .map(|revision| (revision.incarnation.as_str(), revision.revision.as_str()));
                st.db.host_membership_live(
                    &claims.organization_id.to_string(), &claims.principal_id.to_string(), revision,
                ).await.unwrap_or(false)
            }
            // Recheck after proof verification: withdrawal may have committed
            // while a browser or agent credential was being authenticated.
            CredentialKind::BrowserGrant => st.db.browser_grant(&digest, chrono::Utc::now().timestamp())
                .await.ok().flatten().is_some(),
            CredentialKind::AgentCapability => st.db.agent_grant(&digest, chrono::Utc::now().timestamp())
                .await.ok().flatten().is_some(),
        };
        if !live {
            st.sessions.lock().unwrap().remove(&digest);
            return StatusCode::UNAUTHORIZED.into_response();
        }
    }
    next.run(request).await
}
