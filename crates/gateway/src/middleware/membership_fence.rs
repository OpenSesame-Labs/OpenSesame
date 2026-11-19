//! Reload native authority and enforce the durable Identity withdrawal fence.
use crate::{
    app_state::AppState, middleware::auth::require_session, session_claims::CredentialKind,
};
use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};

pub async fn guard(State(st): State<AppState>, request: Request, next: Next) -> Response {
    // Browser DPoP and agent capabilities have their own proof-checking guards.
    // For native bearers, cached claims never grant authority: every request
    // must first find the live session in the shared store.
    let raw = request
        .headers()
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| {
            h.strip_prefix("Bearer ")
                .or_else(|| h.strip_prefix("bearer "))
        })
        .and_then(|token| token.strip_prefix("opaque-session:"));
    if let Some(raw) = raw {
        let digest = opensesame_claims::hash_secret(raw);
        #[cfg(test)]
        let fixture =
            raw.starts_with("fixture_") && st.sessions.lock().unwrap().contains_key(&digest);
        #[cfg(not(test))]
        let fixture = false;
        if !fixture {
            match crate::native_authority::session(st.db.pool(), &digest).await {
                Ok(Some(claims)) if claims.credential_kind == CredentialKind::NativeSession => {
                    let mut sessions = st.sessions.lock().unwrap();
                    sessions.retain(|_, value| value.expires_at > opensesame_time::Utc::now());
                    sessions.insert(digest, claims);
                }
                Ok(_) => {
                    st.sessions.lock().unwrap().remove(&digest);
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
            }
        }
    }
    let session = require_session(&st, request.headers()).ok();
    if let Some((digest, claims)) = session {
        let live = match claims.credential_kind {
            CredentialKind::NativeSession if claims.local_session => true,
            CredentialKind::NativeSession => {
                let Some(revision) = claims.membership_revision.as_ref() else {
                    return StatusCode::UNAUTHORIZED.into_response();
                };
                st.db
                    .host_membership_live(
                        &claims.organization_id.to_string(),
                        &claims.principal_id.to_string(),
                        &revision.incarnation,
                        &revision.revision,
                    )
                    .await
                    .unwrap_or(false)
            }
            // Recheck after proof verification: withdrawal may have committed
            // while a browser or agent credential was being authenticated.
            CredentialKind::BrowserGrant => st
                .db
                .browser_grant(&digest, opensesame_time::Utc::now().timestamp())
                .await
                .ok()
                .flatten()
                .is_some(),
            CredentialKind::AgentCapability => st
                .db
                .agent_grant(&digest, opensesame_time::Utc::now().timestamp())
                .await
                .ok()
                .flatten()
                .is_some(),
        };
        if !live {
            st.sessions.lock().unwrap().remove(&digest);
            return StatusCode::UNAUTHORIZED.into_response();
        }
    }
    next.run(request).await
}
