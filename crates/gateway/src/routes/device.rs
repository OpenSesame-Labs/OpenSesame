use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_time::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::json;

use opensesame_claims::{hash_eq, hash_low_entropy, hash_secret};

use crate::app_state::{AppState, ApprovedDevice};
use crate::middleware::auth::{require_demo_bootstrap, require_operator};

/// Failed `user_code` guesses tolerated across the whole instance per window.
///
/// A guess cannot be attributed to a particular pending authorization, so the
/// fence has to be global. It is a cooldown rather than an invalidation: a wrong
/// guess must never destroy in-flight device authorizations (that would let any
/// caller cancel every pending login).
const MAX_APPROVE_FAILURES: usize = 10;
const APPROVE_FAILURE_WINDOW_SECS: i64 = 60;
#[cfg(test)]
const MAX_PENDING_DEVICE_CODES: usize = 512;
const DEVICE_SCOPE: &str = "opensesame.session";
fn admitted_client(client_id: &str) -> bool {
    matches!(client_id, "opensesame-cli" | "opensesame-pages")
}

/// Drops failures older than the window and reports how many remain.
#[cfg(test)]
fn prune_failures(failures: &mut Vec<DateTime<Utc>>, now: DateTime<Utc>) -> usize {
    let cutoff = now - Duration::seconds(APPROVE_FAILURE_WINDOW_SECS);
    failures.retain(|at| *at > cutoff);
    failures.len()
}

#[derive(Deserialize)]
pub struct DeviceAuthorizeRequest {
    client_id: String,
    scope: Option<String>,
}

pub async fn authorize(
    State(st): State<AppState>,
    Json(req): Json<DeviceAuthorizeRequest>,
) -> impl IntoResponse {
    if !admitted_client(&req.client_id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"unauthorized_client"})),
        )
            .into_response();
    }
    let scope = req.scope.unwrap_or_else(|| DEVICE_SCOPE.into());
    if scope != DEVICE_SCOPE {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_scope"})),
        )
            .into_response();
    }
    let Some(mut verification_uri) = st.client_app_url.clone() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": "device_approval_unavailable",
                "message": "Device approval is unavailable. Ask your administrator to configure the OpenSesame app URL."
            })),
        )
            .into_response();
    };
    verification_uri
        .path_segments_mut()
        .expect("validated client app URL")
        .pop_if_empty()
        .push("device");
    for _ in 0..8 {
        let device_code = format!("dc_{}", uuid::Uuid::new_v4());
        let user_code = opensesame_claims::generate_user_code();
        let device_digest = hash_secret(&device_code);
        let pending = crate::app_state::DevicePending {
            user_code_hash: user_code_digest(&st.claim_pepper, &device_digest, &user_code),
            client_id: req.client_id.clone(),
            scope: scope.clone(),
            expires_at: Utc::now() + Duration::minutes(15),
            approved: None,
        };
        use crate::native_device::Create;
        match crate::native_device::create(&st, &device_digest, &pending, &user_code).await {
            Ok(Create::Inserted) => {
                let mut complete = verification_uri.clone();
                complete
                    .query_pairs_mut()
                    .append_pair("user_code", &user_code);
                return Json(json!({
                    "device_code": device_code, "user_code": user_code,
                    "verification_uri": verification_uri.as_str(),
                    "verification_uri_complete": complete.as_str(),
                    "expires_in": 900, "interval": 5, "client_id": req.client_id, "scope": scope
                }))
                .into_response();
            }
            Ok(Create::Collision) => continue,
            Ok(Create::Capacity) => {
                return (
                    StatusCode::TOO_MANY_REQUESTS,
                    Json(json!({"error":"device_code_capacity"})),
                )
                    .into_response()
            }
            Err(error) => {
                tracing::warn!(%error, "device authorization store unavailable");
                return StatusCode::SERVICE_UNAVAILABLE.into_response();
            }
        }
    }
    StatusCode::SERVICE_UNAVAILABLE.into_response()
}

#[derive(Deserialize)]
pub struct DeviceTokenRequest {
    device_code: String,
    client_id: String,
    grant_type: String,
}

pub async fn token(State(st): State<AppState>, Json(req): Json<DeviceTokenRequest>) -> Response {
    if req.grant_type != "urn:ietf:params:oauth:grant-type:device_code" {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"unsupported_grant_type"})),
        )
            .into_response();
    }
    let result =
        crate::native_device::exchange(&st, &hash_secret(&req.device_code), &req.client_id).await;
    use crate::native_device::Exchange;
    match result {
        Ok(Exchange::Granted { session_id, claims }) => {
            let meta = claims.public_view();
            st.sessions
                .lock()
                .unwrap()
                .insert(hash_secret(&session_id), claims);
            (
                StatusCode::OK,
                [("cache-control", "no-store")],
                Json(json!({
                    "token_type":"Bearer", "expires_in":300, "session":meta,
                    "access_token":format!("opaque-session:{session_id}")
                })),
            )
                .into_response()
        }
        Ok(Exchange::Invalid) => (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_grant"})),
        )
            .into_response(),
        Ok(Exchange::Expired) => (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"expired_token"})),
        )
            .into_response(),
        Ok(Exchange::Pending) => (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"authorization_pending"})),
        )
            .into_response(),
        Ok(Exchange::Capacity) => (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({"error":"session_capacity"})),
        )
            .into_response(),
        Err(error) => {
            tracing::warn!(%error, "device token store unavailable");
            StatusCode::SERVICE_UNAVAILABLE.into_response()
        }
    }
}

#[derive(Deserialize)]
pub struct DeviceApproveRequest {
    user_code: String,
    principal: Option<String>,
    organization_id: Option<String>,
    organization_role: Option<opensesame_domain::OrganizationRole>,
    membership_incarnation: Option<String>,
    authority_revision: Option<String>,
}

fn approved_organization(
    organization_id: Option<&str>,
    organization_role: Option<opensesame_domain::OrganizationRole>,
    operator_default: Option<opensesame_domain::OrganizationId>,
) -> Result<
    (
        opensesame_domain::OrganizationId,
        opensesame_domain::OrganizationRole,
    ),
    &'static str,
> {
    match (organization_id, organization_role) {
        (Some(id), Some(role)) => opensesame_domain::OrganizationId::parse(id)
            .map(|id| (id, role))
            .map_err(|_| "invalid_organization_id"),
        (None, None) => operator_default
            .map(|id| (id, opensesame_domain::OrganizationRole::Owner))
            .ok_or("demo_bootstrap_unavailable"),
        _ => Err("organization_claims_incomplete"),
    }
}

/// Keyed, per-device digest of a user code.
fn user_code_digest(pepper: &str, device_digest: &str, user_code: &str) -> String {
    hash_low_entropy(pepper, device_digest, user_code)
}
pub async fn approve(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(req): Json<DeviceApproveRequest>,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers) {
        return resp;
    }
    let revision = match approval::membership_revision(&req) {
        Ok(revision) => revision,
        Err(()) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"membership_revision_required"})),
            )
                .into_response()
        }
    };
    approval::approve_native(&st, &headers, &req, revision).await
}

/// Identity uses this distinct path so an older Host cannot ignore the tuple.
pub async fn approve_membership(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(req): Json<DeviceApproveRequest>,
) -> Response {
    if let Err(resp) = require_operator(&st, &headers) {
        return resp;
    }
    let revision = match approval::membership_revision(&req) {
        Ok(Some(revision)) => revision,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"membership_revision_required"})),
            )
                .into_response()
        }
    };
    approval::approve_native(&st, &headers, &req, Some(revision)).await
}

#[path = "device_approval.rs"]
mod approval;

#[cfg(test)]
#[path = "device_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "device_membership_tests.rs"]
mod membership_tests;

#[cfg(test)]
#[path = "device_verification_tests.rs"]
mod verification_tests;

#[cfg(test)]
#[path = "device_replica_tests.rs"]
mod replica_tests;
