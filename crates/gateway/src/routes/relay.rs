//! Relayed execution (ADR 0046): the credential stays with its holder, the
//! delegate's *request* travels, and the holder's runtime executes it.
//!
//! The holder-side execution and per-use authorization required by ADR 0046
//! are not implemented. A result reported after an external side effect cannot
//! authorize that effect. New submissions, executable inbox disclosure, and
//! approval therefore fail closed. Existing requests can still be inspected or
//! denied. Result reporting remains unavailable until its authority check and
//! update share a durable transaction.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_time::{DateTime, Utc};
use serde_json::json;
#[cfg(test)]
use serde_json::Value;
use sqlx::Row;

use crate::app_state::AppState;
#[path = "relay_scope.rs"]
mod scope;
use scope::caller_scope;

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

/// New requests are refused until a holder can independently authorize each
/// effect at the execution boundary. Authentication still precedes the reply.
pub async fn submit(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
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

/// Previously approved results also fail closed until authority revalidation
/// and the result write can share the same durable transaction.
pub async fn result(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(_id): Path<String>,
) -> Response {
    if let Err(response) = caller_scope(&st, &headers) {
        return response;
    }
    execution_unavailable()
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
