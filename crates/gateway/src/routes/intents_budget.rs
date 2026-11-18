//! Invoke-path budget spends: delegation ledger + authority ledger (INV-BUDGET).
//!
//! Kept out of `intents.rs` so that file can ratchet down rather than grow past
//! its recorded max-lines. Delegation spend is the ADR 0044 connection-offer
//! meter; authority spend is the conserved `authority_budgets` ledger that
//! storage already proves under concurrency.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_broker::{invocation_fingerprint, InvokeInput};
use opensesame_connection_broker::delegation_invoke_budget::InvokeBudgetClaim;
use opensesame_storage::authority::InvokeBudgetOutcome;
use serde_json::json;

use crate::app_state::AppState;

use super::intents::ResolvedInvocation;

/// Holds taken against `authority_budgets` for this invoke, if any.
struct AuthorityBudgetHold {
    organization_id: String,
    keys: Vec<String>,
}

/// Only the request that created the durable claim may release its holds.
pub(super) struct InvokeBudgetHold {
    organization_id: String,
    claim_id: String,
    authority: Option<AuthorityBudgetHold>,
}

/// Claim the invocation and spend both meters after authorization and before execution.
/// A prior intent skips spending and must still pass broker replay checks.
///
/// # Errors
///
/// Returns 403 when a ledger refuses the spend, or 409 for an incompatible
/// or not-yet-persisted invocation using the same idempotency key.
pub(super) async fn spend_invoke_budgets(
    st: &AppState,
    organization_id: &str,
    resolved: &ResolvedInvocation,
    input: &InvokeInput,
) -> Result<Option<InvokeBudgetHold>, Response> {
    let key = &input.intent.idempotency_key;
    // A previously stored intent is replayed through the broker, which checks
    // the exact binding and current authorization before returning a receipt.
    if st
        .db
        .find_idempotent_intent(&input.intent.organization_id, key)
        .await
        .map_err(|_| budget_exhausted())?
        .is_some()
    {
        return Ok(None);
    }
    let fingerprint = invocation_budget_binding(st, input).map_err(|_| budget_exhausted())?;
    let claim = st
        .connection_broker
        .claim_invoke_budget(
            organization_id,
            key,
            &fingerprint,
            resolved.spend_budget.as_deref(),
        )
        .await
        .map_err(|_| budget_exhausted())?;
    let claim_id = match claim {
        InvokeBudgetClaim::Reserved { claim_id } => claim_id,
        InvokeBudgetClaim::Conflict => return Err(idempotency_conflict()),
        InvokeBudgetClaim::Duplicate => {
            // Only the broker's persisted intent can make a retry safe. A
            // claim without an intent is in flight or survived a crash before
            // the outcome became known: fail closed rather than run for free.
            return if st
                .db
                .find_idempotent_intent(&input.intent.organization_id, key)
                .await
                .map_err(|_| budget_exhausted())?
                .is_some()
            {
                Ok(None)
            } else {
                Err(idempotency_conflict())
            };
        }
    };
    // This per-claim key avoids reopening an earlier released authority hold.
    let authority = match spend_authority_budget(st, organization_id, resolved, &claim_id).await {
        Ok(hold) => hold,
        Err(response) => {
            let _ = st
                .connection_broker
                .release_invoke_budget_claim(organization_id, &claim_id)
                .await;
            return Err(response);
        }
    };
    Ok(Some(InvokeBudgetHold {
        organization_id: organization_id.to_owned(),
        claim_id,
        authority,
    }))
}

pub(super) fn invocation_budget_binding(
    st: &AppState,
    input: &InvokeInput,
) -> anyhow::Result<String> {
    let fingerprint = invocation_fingerprint(input)?;
    let fingerprint = serde_json::to_string(&fingerprint)?;
    // Do not expose a dictionary-checkable digest of request parameters in a
    // database row: bind it under the deployment's existing claim pepper.
    Ok(opensesame_claims::hash_low_entropy(
        &st.claim_pepper,
        "invocation-budget-fingerprint-v1",
        &fingerprint,
    ))
}

/// After an authorized broker replay returns its receipt, complete any hold
/// whose settlement was interrupted after the original provider outcome.
pub(super) async fn settle_replayed_invoke(
    st: &AppState,
    organization_id: &str,
    idempotency_key: &str,
    fingerprint: &str,
) {
    let claim: Result<Option<String>, _> = sqlx::query_scalar(
        "SELECT claim_id FROM invocation_budget_claims \
         WHERE organization_id = ? AND idempotency_key = ? AND fingerprint = ?",
    )
    .bind(organization_id)
    .bind(idempotency_key)
    .bind(fingerprint)
    .fetch_optional(st.db.pool())
    .await;
    if let Ok(Some(claim_id)) = claim {
        let _ = st
            .db
            .settle_invoke_claim_budgets(organization_id, &claim_id)
            .await;
    }
}

/// Settle authority holds after the provider outcome (unknown outcomes charge).
pub(super) async fn settle_authority_budget_hold(st: &AppState, hold: Option<InvokeBudgetHold>) {
    let Some(hold) = hold.and_then(|hold| hold.authority) else {
        return;
    };
    let _ = st
        .db
        .settle_invoke_budgets(&hold.organization_id, &hold.keys)
        .await;
}

/// Release a hold that never reached the side-effect boundary (AT-REVOKE-QUEUE).
pub(super) async fn release_authority_budget_hold(st: &AppState, hold: Option<InvokeBudgetHold>) {
    let Some(hold) = hold else {
        return;
    };
    if let Some(authority) = hold.authority {
        let _ = st
            .db
            .release_invoke_budgets(&authority.organization_id, &authority.keys)
            .await;
    }
    let _ = st
        .connection_broker
        .release_invoke_budget_claim(&hold.organization_id, &hold.claim_id)
        .await;
}

async fn spend_authority_budget(
    st: &AppState,
    organization_id: &str,
    resolved: &ResolvedInvocation,
    idempotency_key: &str,
) -> Result<Option<AuthorityBudgetHold>, Response> {
    let grant_id = resolved.grant.id.to_string();
    match st
        .db
        .reserve_invoke_budgets(organization_id, &grant_id, idempotency_key)
        .await
    {
        Ok(InvokeBudgetOutcome::Skipped) => Ok(None),
        Ok(InvokeBudgetOutcome::Reserved { keys }) => Ok(Some(AuthorityBudgetHold {
            organization_id: organization_id.to_string(),
            keys,
        })),
        Ok(InvokeBudgetOutcome::Exhausted) | Err(_) => Err(budget_exhausted()),
    }
}

fn budget_exhausted() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({"error": "budget_exhausted"})),
    )
        .into_response()
}

fn idempotency_conflict() -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({"error": "idempotency_conflict"})),
    )
        .into_response()
}
