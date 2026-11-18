//! Relayed execution (ADR 0046): the credential stays with its holder, the
//! delegate's *request* travels, and the holder's runtime executes it.
//!
//! The holder-side execution and per-use authorization required by ADR 0046
//! are not implemented. A result reported after an external side effect cannot
//! authorize that effect. New submissions, executable inbox disclosure, and
//! approval therefore fail closed. Existing requests can still be inspected or
//! denied, and results from previously approved work can still be reported.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Utc};
use opensesame_authz::assert_no_secret_in_agent_payload;
use opensesame_connection_broker::delegation::ResolvedDelegation;
use opensesame_domain::AvailabilityClass;
use opensesame_relay::{admit, ExecutionMode, HolderLiveness, RelayAdmission, RelayRefusal};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;

use crate::app_state::AppState;
#[path = "relay_scope.rs"]
mod scope;
use scope::caller_scope;

fn relay_error(refusal: RelayRefusal) -> Response {
    let (status, code) = match refusal {
        RelayRefusal::NotRelayMode => (StatusCode::CONFLICT, "not_relay_mode"),
        RelayRefusal::HolderOffline => (StatusCode::CONFLICT, "holder_offline"),
        RelayRefusal::DigestMismatch => (StatusCode::CONFLICT, "digest_mismatch"),
        RelayRefusal::ApprovalRequired => (StatusCode::FORBIDDEN, "approval_required"),
        RelayRefusal::MaterializeDenied => (StatusCode::FORBIDDEN, "materialize_denied"),
    };
    (status, Json(json!({"error": code}))).into_response()
}

fn error_response(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({"error": code}))).into_response()
}

fn not_found() -> Response {
    error_response(StatusCode::NOT_FOUND, "not_found")
}

fn execution_unavailable() -> Response {
    error_response(StatusCode::NOT_IMPLEMENTED, "relay_execution_unavailable")
}

/// Heartbeats are unavailable until a holder runtime can use them.
pub async fn heartbeat(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    if let Err(response) = caller_scope(&st, &headers) {
        return response;
    }
    execution_unavailable()
}

async fn resolve_submit_delegation(
    st: &AppState,
    organization: &opensesame_domain::OrganizationId,
    subject: &str,
    delegation_id: &str,
) -> Result<ResolvedDelegation, Response> {
    let mine = st
        .connection_broker
        .list_delegations_for(organization, subject)
        .await
        .map_err(|_| not_found())?;
    mine.iter()
        .find(|delegation| delegation.id == delegation_id && delegation.claimant_subject == subject)
        .ok_or_else(not_found)?;
    match st
        .connection_broker
        .find_live_delegation_by_id(subject, delegation_id)
        .await
    {
        Ok(Some(resolved)) if resolved.delegation_id == delegation_id => Ok(resolved),
        _ => Err(not_found()),
    }
}

fn authorize_relay_request(
    resolved: &ResolvedDelegation,
    operation: &str,
    resource: &str,
) -> Result<(), Response> {
    if !resolved
        .grant
        .actions
        .iter()
        .any(|action| action == operation)
    {
        return Err(error_response(StatusCode::FORBIDDEN, "action_not_granted"));
    }
    if !resolved.grant.permits_resource(resource) {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "resource_not_granted",
        ));
    }
    Ok(())
}

/// New requests are refused until a holder can independently authorize each
/// effect at the execution boundary. Authentication still precedes the reply.
pub async fn submit(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(_body): Json<Value>,
) -> Response {
    if let Err(response) = caller_scope(&st, &headers) {
        return response;
    }
    execution_unavailable()
}

fn expired(row_expires: &str, now: DateTime<Utc>) -> bool {
    DateTime::parse_from_rfc3339(row_expires).map_or(true, |time| now >= time.with_timezone(&Utc))
}

/// Do not disclose executable work to an executor which cannot re-authorize.
/// Existing requests remain inspectable by id and can be denied.
pub async fn pending(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    if let Err(response) = caller_scope(&st, &headers) {
        return response;
    }
    execution_unavailable()
}

/// Approval stays unavailable until a holder runtime can enforce it.
pub async fn approve(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(_id): Path<String>,
    Json(_body): Json<Value>,
) -> Response {
    if let Err(response) = caller_scope(&st, &headers) {
        return response;
    }
    execution_unavailable()
}

/// A holder may still deny a pending request without seeing its executable
/// details. The immutable ID, tenant, holder and pending state bind the denial;
/// a denial cannot authorize execution or change an already approved request.
pub async fn deny(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    Json(_body): Json<Value>,
) -> Response {
    let (organization, subject) = match caller_scope(&st, &headers) {
        Ok(scope) => scope,
        Err(response) => return response,
    };
    let now = Utc::now().to_rfc3339();
    let updated = sqlx::query(
        "UPDATE relay_requests
         SET state = 'denied', approved_at = ?, decided_by = ?
         WHERE id = ? AND organization_id = ? AND holder_subject = ?
           AND state = 'pending_approval' AND expires_at > ?",
    )
    .bind(&now)
    .bind(&subject)
    .bind(&id)
    .bind(organization.to_string())
    .bind(&subject)
    .bind(&now)
    .execute(st.connection_broker.pool())
    .await;
    match updated {
        Ok(result) if result.rows_affected() == 1 => {
            Json(json!({"id": id, "state": "denied"})).into_response()
        }
        _ => not_found(),
    }
}

#[derive(Deserialize)]
pub struct ResultRequest {
    /// The digest of what the holder's runtime actually executed.
    executed_digest: String,
    outcome: String,
    #[serde(default)]
    safe_summary: Option<Value>,
}

struct ResultContext {
    approved_digest: String,
    approved: bool,
}

async fn load_result_context(
    st: &AppState,
    id: &str,
    organization: opensesame_domain::OrganizationId,
    holder_subject: &str,
) -> Result<ResultContext, Response> {
    let row = sqlx::query(
        "SELECT delegation_id, holder_subject, delegate_subject, request_digest, state, expires_at
         FROM relay_requests WHERE id = ? AND organization_id = ? AND holder_subject = ?",
    )
    .bind(id)
    .bind(organization.to_string())
    .bind(holder_subject)
    .fetch_optional(st.connection_broker.pool())
    .await;
    let Ok(Some(row)) = row else {
        return Err(not_found());
    };
    if expired(&row.get::<String, _>("expires_at"), Utc::now()) {
        return Err(error_response(StatusCode::GONE, "expired"));
    }
    Ok(ResultContext {
        approved_digest: row.get("request_digest"),
        approved: row.get::<String, _>("state") == "approved",
    })
}

/// Resolve the frozen request against today's delegation and every ancestor,
/// before disclosing executable bytes, approving them, or accepting a result.
async fn current_authority(
    st: &AppState,
    id: &str,
    organization: opensesame_domain::OrganizationId,
    holder: &str,
) -> Result<ExecutionMode, Response> {
    let row = sqlx::query(
        "SELECT delegation_id, connection_id, organization_id, holder_subject,
                delegate_subject, operation, resource, expires_at
         FROM relay_requests WHERE id = ? AND organization_id = ? AND holder_subject = ?",
    )
    .bind(id)
    .bind(organization.to_string())
    .bind(holder)
    .fetch_optional(st.connection_broker.pool())
    .await
    .map_err(|_| error_response(StatusCode::SERVICE_UNAVAILABLE, "relay_unavailable"))?
    .ok_or_else(not_found)?;
    if expired(&row.get::<String, _>("expires_at"), Utc::now()) {
        return Err(not_found());
    }
    let delegate: String = row.get("delegate_subject");
    let delegation_id: String = row.get("delegation_id");
    let resolved = resolve_submit_delegation(st, &organization, &delegate, &delegation_id).await?;
    if resolved.owner_subject != holder
        || resolved.connection_id != row.get::<String, _>("connection_id")
        || resolved.execution_mode != ExecutionMode::Relay
    {
        return Err(not_found());
    }
    authorize_relay_request(
        &resolved,
        &row.get::<String, _>("operation"),
        &row.get::<String, _>("resource"),
    )?;
    Ok(resolved.execution_mode)
}

fn validate_result(
    mode: ExecutionMode,
    context: &ResultContext,
    body: &ResultRequest,
) -> Result<(), Response> {
    let admission = RelayAdmission {
        mode,
        // The holder is reporting a result; it is by definition reachable.
        liveness: HolderLiveness::Online,
        class: AvailabilityClass::A3ExternalSideEffect,
        offline_use: opensesame_domain::OfflineUse::Forbidden,
        approved_digest: &context.approved_digest,
        executing_digest: &body.executed_digest,
        approval_required: true,
        approved: context.approved,
        materialize: false,
    };
    admit(&admission).map_err(relay_error)?;

    let summary = body.safe_summary.clone().unwrap_or_else(|| json!({}));
    assert_no_secret_in_agent_payload(&summary)
        .map_err(|_| error_response(StatusCode::UNPROCESSABLE_ENTITY, "summary_rejected"))?;
    Ok(())
}

async fn complete_result(
    st: &AppState,
    id: &str,
    organization: opensesame_domain::OrganizationId,
    holder: &str,
    requested_outcome: &str,
) -> Response {
    let outcome = if requested_outcome == "succeeded" {
        "succeeded"
    } else {
        "failed"
    };
    let updated = sqlx::query(
        "UPDATE relay_requests
         SET state = 'completed', result_json = NULL, result_outcome = ?, completed_at = ?
         WHERE id = ? AND organization_id = ? AND holder_subject = ? AND state = 'approved'",
    )
    .bind(outcome)
    .bind(Utc::now().to_rfc3339())
    .bind(id)
    .bind(organization.to_string())
    .bind(holder)
    .execute(st.connection_broker.pool())
    .await;
    match updated {
        Ok(result) if result.rows_affected() == 1 => {
            Json(json!({"id": id, "state": "completed", "outcome": outcome})).into_response()
        }
        _ => error_response(StatusCode::CONFLICT, "conflict"),
    }
}

/// `POST /api/v1/relay/requests/{id}/result` — the holder reports back.
///
/// This records previously approved work; it cannot authorize an effect that
/// already happened. Live authority and the approved digest are rechecked.
pub async fn result(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<ResultRequest>,
) -> Response {
    let (organization, subject) = match caller_scope(&st, &headers) {
        Ok(scope) => scope,
        Err(resp) => return resp,
    };
    let context = match load_result_context(&st, &id, organization, &subject).await {
        Ok(context) => context,
        Err(response) => return response,
    };

    // The delegation may have been revoked or narrowed since approval; the
    // stored digest pins the request, but authority is re-read live.
    let mode = match current_authority(&st, &id, organization, &subject).await {
        Ok(mode) => mode,
        Err(response) => return response,
    };

    // A holder-authored summary cannot prove it is safe to disclose. Accept
    // the legacy field only for compatibility, and never persist or relay it.
    if let Err(response) = validate_result(mode, &context, &body) {
        return response;
    }
    complete_result(&st, &id, organization, &subject, &body.outcome).await
}

/// `GET /api/v1/relay/requests/{id}` — delegate or holder polls.
pub async fn get(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let (organization, subject) = match caller_scope(&st, &headers) {
        Ok(scope) => scope,
        Err(resp) => return resp,
    };
    let row = sqlx::query(
        "SELECT holder_subject, delegate_subject, state, result_outcome, expires_at
         FROM relay_requests WHERE id = ? AND organization_id = ?",
    )
    .bind(&id)
    .bind(organization.to_string())
    .fetch_optional(st.connection_broker.pool())
    .await;
    let Ok(Some(row)) = row else {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response();
    };
    let holder: String = row.get("holder_subject");
    let delegate: String = row.get("delegate_subject");
    if subject != holder && subject != delegate {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response();
    }
    let raw_state: String = row.get("state");
    let state =
        if raw_state != "completed" && expired(&row.get::<String, _>("expires_at"), Utc::now()) {
            "expired"
        } else {
            match raw_state.as_str() {
                "pending_approval" | "approved" | "denied" | "completed" | "failed" | "expired" => {
                    &raw_state
                }
                _ => "unknown",
            }
        };
    let outcome: Option<String> = row.get("result_outcome");
    let outcome = outcome.filter(|value| value == "succeeded" || value == "failed");
    Json(json!({"id": id, "state": state, "outcome": outcome})).into_response()
}

#[cfg(test)]
#[path = "relay_tests.rs"]
mod tests;
