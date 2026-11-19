use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_time::Utc;
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;

use crate::app_state::AppState;
use crate::middleware::auth::{
    require_demo_bootstrap, require_operator, require_session, require_session_or_operator,
    same_principal_subject,
};
use crate::session_claims::HostSessionClaims;

pub async fn status(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    if let Err(resp) = require_session_or_operator(&st, &headers) {
        return resp;
    }
    match sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM host_native_sessions WHERE expires_at>?",
    )
    .bind(Utc::now().timestamp_millis())
    .fetch_one(st.db.pool())
    .await
    {
        Ok(n) => Json(json!({"active_sessions": n})).into_response(),
        Err(_) => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}

/// Explicit operator-only local development session. Browsers use pairing.
pub async fn local_mint(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    if let Err(response) = require_operator(&st, &headers) {
        return response;
    }
    if st.deployment.production_safeguards() {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "local_session_forbidden",
                "hint": "Host-local sessions are disabled in production. Use Identity device approval."
            })),
        )
            .into_response();
    }
    let boot = match require_demo_bootstrap(&st) {
        Ok(boot) => boot,
        Err(resp) => return resp,
    };

    if opensesame_connection_broker::config_access::provision_native_role(
        st.db.pool(),
        &boot.org,
        &boot.principal,
        opensesame_domain::OrganizationRole::Owner,
    )
    .await
    .is_err()
    {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let session_id = format!("sess_{}", uuid::Uuid::new_v4());
    let session_digest = opensesame_claims::hash_secret(&session_id);
    let mut claims = HostSessionClaims::operator_approved(
        boot.principal,
        boot.org,
        opensesame_domain::OrganizationRole::Owner,
        "opensesame-cli".into(),
        st.resource.clone(),
    );
    claims.actor_id = Some(boot.actor);
    claims.project_id = Some(boot.project);
    claims.credential_handle = Some(format!("handle_{}", uuid::Uuid::new_v4()));
    claims.local_session = true;
    let meta = claims.public_view();
    match crate::native_authority::mint_local(st.db.pool(), &session_digest, &claims).await {
        Ok(true) => {
            st.sessions.lock().unwrap().insert(session_digest, claims);
        }
        Ok(false) => {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({"error":"session_capacity"})),
            )
                .into_response()
        }
        Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }

    (
        StatusCode::OK,
        [("cache-control", "no-store")],
        Json(json!({
            "token_type": "Bearer",
            "expires_in": 300,
            "session": meta,
            "access_token": format!("opaque-session:{session_id}"),
            "local_session": true,
        })),
    )
        .into_response()
}

pub async fn whoami(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    if let Ok((_, claims)) = require_session(&st, &headers) {
        return Json(claims.public_view()).into_response();
    }
    if let Err(response) = require_operator(&st, &headers) {
        return response;
    }
    Json(json!({"authentication":"operator", "assurance":"local_unverified", "issuer":st.issuer}))
        .into_response()
}

#[derive(Deserialize)]
pub struct RevokeSessionsRequest {
    principal_id: String,
    organization_id: String,
    membership_incarnation: String,
    authority_revision: String,
    withdrawal_id: String,
}

fn matches_revision(
    actual: Option<&crate::session_claims::MembershipRevision>,
    target: &crate::session_claims::MembershipRevision,
    include_legacy: bool,
) -> bool {
    actual.map_or(include_legacy, |actual| actual == target)
}

fn revoke_specific_sessions(
    sessions: &mut HashMap<String, HostSessionClaims>,
    principal_id: &str,
    organization_id: &str,
    target: &crate::session_claims::MembershipRevision,
    include_legacy: bool,
) -> usize {
    let before = sessions.len();
    sessions.retain(|_, meta| {
        !same_principal_subject(&meta.principal_id.to_string(), principal_id)
            || meta.organization_id.to_string() != organization_id
            || !matches_revision(meta.membership_revision.as_ref(), target, include_legacy)
    });
    before - sessions.len()
}

#[cfg(test)]
fn revoke_specific_authorizations(
    pending: &mut HashMap<String, crate::app_state::DevicePending>,
    principal_id: &str,
    organization_id: opensesame_domain::OrganizationId,
    target: &crate::session_claims::MembershipRevision,
    include_legacy: bool,
) -> usize {
    let mut revoked = 0;
    for authorization in pending.values_mut() {
        if authorization.approved.as_ref().is_some_and(|approved| {
            same_principal_subject(&approved.principal, principal_id)
                && approved.organization_id == organization_id
                && matches_revision(
                    approved.membership_revision.as_ref(),
                    target,
                    include_legacy,
                )
        }) {
            authorization.approved = None;
            revoked += 1;
        }
    }
    revoked
}

pub async fn revoke(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(req): Json<RevokeSessionsRequest>,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers) {
        return resp;
    }
    let Ok(organization_id) = opensesame_domain::OrganizationId::parse(&req.organization_id) else {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_organization_id"})),
        )
            .into_response();
    };
    let Some(principal) = crate::session_claims::parse_principal(&req.principal_id) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let valid_uuid = |value: &str| {
        uuid::Uuid::parse_str(value).is_ok_and(|id| !id.is_nil() && id.to_string() == value)
    };
    if organization_id.as_uuid().is_nil()
        || !valid_uuid(&req.membership_incarnation)
        || !valid_uuid(&req.authority_revision)
        || !valid_uuid(&req.withdrawal_id)
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let canonical_organization_id = organization_id.to_string();
    let principal_id = principal.to_string();
    let target = crate::session_claims::MembershipRevision {
        incarnation: req.membership_incarnation,
        revision: req.authority_revision,
    };
    // The database transaction also clears pending grants and native sessions;
    // approval and token exchange take the same write lock across replicas.
    let (include_legacy, revoked) = match st
        .db
        .withdraw_host_membership_with_count(
            &opensesame_storage::host_membership::MembershipWithdrawal {
                withdrawal_id: &req.withdrawal_id,
                organization_id: &canonical_organization_id,
                principal_id: &principal_id,
                membership_incarnation: &target.incarnation,
                authority_revision: &target.revision,
            },
            Utc::now().timestamp(),
        )
        .await
    {
        Ok(inserted) => inserted,
        Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
    };
    let mut sessions = st.sessions.lock().unwrap();
    revoke_specific_sessions(
        &mut sessions,
        &principal_id,
        &canonical_organization_id,
        &target,
        include_legacy,
    );
    drop(sessions);

    Json(json!({
        "revoked": revoked,
        "durable": true,
        "withdrawal_id": req.withdrawal_id,
        "membership_incarnation": target.incarnation,
        "authority_revision": target.revision,
    }))
    .into_response()
}

#[cfg(test)]
fn revoke_matching_sessions(
    sessions: &mut HashMap<String, HostSessionClaims>,
    principal: &str,
    org: &str,
) -> usize {
    revoke_specific_sessions(
        sessions,
        principal,
        org,
        &crate::session_claims::MembershipRevision {
            incarnation: String::new(),
            revision: String::new(),
        },
        true,
    )
}

#[cfg(test)]
fn revoke_pending_authorizations(
    pending: &mut HashMap<String, crate::app_state::DevicePending>,
    principal: &str,
    org: opensesame_domain::OrganizationId,
) -> usize {
    revoke_specific_authorizations(
        pending,
        principal,
        org,
        &crate::session_claims::MembershipRevision {
            incarnation: String::new(),
            revision: String::new(),
        },
        true,
    )
}

#[cfg(test)]
pub fn list_connections(State(st): State<AppState>, headers: &axum::http::HeaderMap) -> Response {
    let caller = match crate::middleware::auth::resolve_caller(&st, headers) {
        Ok(caller) => caller,
        Err(resp) => return resp,
    };
    let Some(connection_ref) = &st.connection_ref else {
        return Json(json!({"connections": []})).into_response();
    };
    let boot = match require_demo_bootstrap(&st) {
        Ok(boot) => boot,
        Err(resp) => return resp,
    };
    if !caller.in_organization(&boot.org) {
        return Json(json!({"connections": []})).into_response();
    }
    Json(json!({
        "connections": [{
            "connection_ref": connection_ref.handle.uri(),
            "connection_id": connection_ref.connection_id.to_string(),
            "logical_name": connection_ref.handle.logical_name,
            "max_invoke_level": 2,
            "operations": ["repository.read", "pull_request.create"]
        }]
    }))
    .into_response()
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;
