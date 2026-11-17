//! Validation and publication of an operator-approved device grant.
use super::*;

pub(super) fn membership_revision(req: &DeviceApproveRequest) -> Result<Option<crate::session_claims::MembershipRevision>, ()> {
    let local = req.organization_id.is_none() && req.organization_role.is_none();
    match (&req.membership_incarnation, &req.authority_revision, local) {
        (None, None, true) => Ok(None),
        (Some(incarnation), Some(revision), false)
            if [incarnation, revision].iter().all(|value| uuid::Uuid::parse_str(value)
                .is_ok_and(|id| !id.is_nil() && id.to_string() == value.as_str())) =>
        {
            Ok(Some(crate::session_claims::MembershipRevision {
                incarnation: incarnation.clone(),
                revision: revision.clone(),
            }))
        }
        _ => Err(()),
    }
}


pub(super) fn clear_approval(st: &AppState, user_code: &str) {
    for (device_digest, pending) in st.device_codes.lock().unwrap().iter_mut() {
        if hash_eq(&user_code_digest(&st.claim_pepper, device_digest, user_code), &pending.user_code_hash) {
            pending.approved = None;
            break;
        }
    }
}


pub(super) fn approve_native(
    st: &AppState,
    headers: &axum::http::HeaderMap,
    req: &DeviceApproveRequest,
    membership_revision: Option<crate::session_claims::MembershipRevision>,
) -> Response {
    if let Err(resp) = require_operator(st, headers) {
        return resp;
    }
    let now = Utc::now();
    // Hold the failure fence across the guess so concurrent misses cannot all
    // observe count < MAX and then all push.
    let mut failures = st.device_approve_failures.lock().unwrap();
    if prune_failures(&mut failures, now) >= MAX_APPROVE_FAILURES {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({
                "error": "too_many_attempts",
                "retry_after_seconds": APPROVE_FAILURE_WINDOW_SECS,
            })),
        )
            .into_response();
    }

    let mut map = st.device_codes.lock().unwrap();
    map.retain(|_, p| p.expires_at > now);
    // The digest is bound per device code, so the attempt is recomputed for each
    // candidate rather than compared against one global hash.
    for (device_digest, pending) in map.iter_mut() {
        let attempt_hash = user_code_digest(&st.claim_pepper, device_digest, &req.user_code);
        if hash_eq(&attempt_hash, &pending.user_code_hash) {
            drop(failures);
            let operator_default =
                if req.organization_id.is_none() && req.organization_role.is_none() {
                    match require_demo_bootstrap(st) {
                        Ok(boot) => Some(boot.org),
                        Err(resp) => return resp,
                    }
                } else {
                    None
                };
            let organization = match approved_organization(
                req.organization_id.as_deref(),
                req.organization_role,
                operator_default,
            ) {
                Ok(organization) => organization,
                Err(error) => {
                    return (StatusCode::BAD_REQUEST, Json(json!({"error":error}))).into_response();
                }
            };
            let Some(principal) = req
                .principal
                .as_deref()
                .and_then(crate::session_claims::parse_principal)
            else {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"error":"principal_required"})),
                )
                    .into_response();
            };
            pending.approved = Some(ApprovedDevice {
                principal: principal.to_string(),
                organization_id: organization.0,
                organization_role: organization.1,
                membership_revision: membership_revision.clone(),
            });
            return (
                StatusCode::OK,
                Json(json!({
                    "status":"approved",
                    "client_id": pending.client_id,
                    "scope": pending.scope,
                })),
            )
                .into_response();
        }
    }
    // A miss costs the guesser budget, not the pending authorizations.
    // Push while still holding `failures` — a second lock here deadlocks
    // `std::sync::Mutex` and lets concurrent misses all observe count < MAX.
    failures.push(now);
    (
        StatusCode::NOT_FOUND,
        Json(json!({"error":"unknown_user_code"})),
    )
        .into_response()
}
