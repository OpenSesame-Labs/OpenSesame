use super::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DecisionRequest {
    user_code: String,
    decision: Decision,
    principal_id: String,
    organization_id: String,
    membership_incarnation: Option<String>,
    authority_revision: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Decision {
    Approve,
    Deny,
}

pub async fn decision(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<DecisionRequest>,
) -> Response {
    if let Err(response) = require_operator(&st, &headers) {
        return response;
    }
    let Some(principal) = parse_principal(&req.principal_id) else {
        return refusal("invalid_pairing_decision");
    };
    let Ok(org) = OrganizationId::parse(&req.organization_id) else {
        return refusal("invalid_pairing_decision");
    };
    if org.as_uuid().is_nil() || req.user_code.len() > 32 {
        return refusal("invalid_pairing_decision");
    }
    let membership_revision = match (
        req.membership_incarnation.as_deref(),
        req.authority_revision.as_deref(),
    ) {
        (None, None) => None,
        (Some(incarnation), Some(revision))
            if [incarnation, revision].iter().all(|value| {
                uuid::Uuid::parse_str(value)
                    .is_ok_and(|id| !id.is_nil() && id.to_string() == *value)
            }) =>
        {
            Some((incarnation, revision))
        }
        _ => return refusal("invalid_pairing_decision"),
    };
    let now = Utc::now().timestamp();
    if !st
        .db
        .admit_browser_pairing_attempt("pairing-decision", now)
        .await
        .unwrap_or(false)
    {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({"error":"pairing_rate_limited"})),
        )
            .into_response();
    }
    let digest = hash_low_entropy(&st.claim_pepper, "browser-pairing-v1", &req.user_code);
    let Ok(mut tx) = st.db.pool().begin_with("BEGIN IMMEDIATE").await else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    // Read the clock after acquiring the writer so a queued request cannot
    // approve a code that expired while another transaction held the database.
    let decision_now = Utc::now().timestamp();
    let capabilities = match opensesame_storage::browser_pairing::decide_browser_pairing_in_transaction(
        &mut tx,
        &digest,
        &principal.to_string(),
        &org.to_string(),
        matches!(req.decision, Decision::Approve),
        decision_now,
        membership_revision,
    )
    .await
    {
        Ok(Some(capabilities)) => capabilities,
        Ok(None) => return refusal("invalid_pairing_decision"),
        Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
    };
    if matches!(req.decision, Decision::Approve) {
        let Ok(requested) = serde_json::from_str::<Vec<String>>(&capabilities) else {
            return refusal("invalid_pairing_decision");
        };
        if !allowed_capabilities(&requested) {
            return refusal("invalid_pairing_decision");
        }
        if provisions_membership(&requested)
            && opensesame_connection_broker::config_access::provision_native_role_in_transaction(
                &mut tx,
                &org,
                &principal,
                OrganizationRole::Member,
            )
            .await
            .is_err()
        {
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
    }
    if tx.commit().await.is_err() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    StatusCode::NO_CONTENT.into_response()
}
