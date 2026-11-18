//! One-time device grant redemption and native session publication.
use super::*;

pub async fn token(State(st): State<AppState>, Json(req): Json<DeviceTokenRequest>) -> Response {
    if req.grant_type != "urn:ietf:params:oauth:grant-type:device_code" {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"unsupported_grant_type"})))
            .into_response();
    }
    let digest = hash_secret(&req.device_code);
    let (approved, client_id) = {
        let codes = st.device_codes.lock().unwrap();
        let Some(pending) = codes.get(&digest) else {
            return invalid_grant();
        };
        if pending.client_id != req.client_id {
            return invalid_grant();
        }
        if Utc::now() >= pending.expires_at {
            return (StatusCode::BAD_REQUEST, Json(json!({"error":"expired_token"})))
                .into_response();
        }
        let Some(approved) = pending.approved.clone() else {
            return (StatusCode::BAD_REQUEST, Json(json!({"error":"authorization_pending"})))
                .into_response();
        };
        (approved, pending.client_id.clone())
    };
    if let Some(revision) = approved.membership_revision.as_ref() {
        match st.db.host_membership_live(
            &approved.organization_id.to_string(), &approved.principal,
            &revision.incarnation, &revision.revision,
        ).await {
            Ok(true) => {}
            Ok(false) => return invalid_grant(),
            Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
        }
    }
    let boot = st.bootstrap.lock().unwrap().clone().filter(|boot| {
        boot.org == approved.organization_id
            && same_principal_subject(&approved.principal, &boot.principal.to_string())
    });
    let Some(principal) = crate::session_claims::parse_principal(&approved.principal) else {
        st.device_codes.lock().unwrap().remove(&digest);
        return invalid_grant();
    };
    let session_id = format!("sess_{}", uuid::Uuid::new_v4());
    let mut claims = crate::session_claims::HostSessionClaims::operator_approved(
        principal, approved.organization_id, approved.organization_role, client_id,
        st.resource.clone(),
    );
    claims.actor_id = boot.as_ref().map(|value| value.actor);
    claims.project_id = boot.as_ref().map(|value| value.project);
    claims.credential_handle = boot.as_ref().map(|_| format!("handle_{}", uuid::Uuid::new_v4()));
    claims.membership_revision = approved.membership_revision;
    claims.local_session = claims.membership_revision.is_none();
    let meta = claims.public_view();
    {
        let mut codes = st.device_codes.lock().unwrap();
        if codes.get(&digest).and_then(|pending| pending.approved.as_ref()).is_none() {
            return invalid_grant();
        }
        let mut sessions = st.sessions.lock().unwrap();
        sessions.retain(|_, value| value.valid_for(&st.resource, Utc::now()));
        if sessions.len() >= 1024 {
            return (StatusCode::TOO_MANY_REQUESTS, Json(json!({"error":"session_capacity"})))
                .into_response();
        }
        sessions.insert(hash_secret(&session_id), claims);
        codes.remove(&digest);
    }
    (StatusCode::OK, [("cache-control", "no-store")], Json(json!({
        "token_type":"Bearer", "expires_in":300, "session":meta,
        "access_token":format!("opaque-session:{session_id}")
    }))).into_response()
}

fn invalid_grant() -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({"error":"invalid_grant"}))).into_response()
}
