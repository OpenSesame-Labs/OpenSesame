//! Hold-before-side-effect on the invoke path (AZ-DISPATCH / AT-REVOKE-QUEUE).
//!
//! Production and drain share [`finish_dispatch`]: live delegation and the
//! grant window are re-checked immediately before the broker side effect.
//! Tests can arm a one-shot hold so a permitted invoke is queued; fixture
//! work is counted only when `execute_invocation` actually runs.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_broker::InvokeInput;
use opensesame_domain::OrganizationId;
use opensesame_relay::ExecutionMode;
use opensesame_time::Utc;
use serde_json::json;

use super::super::intents_budget::{
    ensure_effect_allowed, invocation_budget_binding, release_authority_budget_hold,
    settle_authority_budget_hold, settle_replayed_invoke, InvokeBudgetHold,
};
use super::{execute_invocation, not_found, ConstrainedHttpInput, ResolvedInvocation};
use crate::app_state::AppState;

fn require_broker_mode(mode: ExecutionMode) -> Result<(), Response> {
    if mode != ExecutionMode::Broker {
        return Err((
            StatusCode::NOT_IMPLEMENTED,
            Json(json!({"error": "relay_execution_unavailable"})),
        )
            .into_response());
    }
    Ok(())
}

pub(super) fn delegated_execution_unavailable() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({"error": "delegated_execution_unavailable"})),
    )
        .into_response()
}

pub(super) fn require_delegated_mode(mode: ExecutionMode) -> Result<(), Response> {
    require_broker_mode(mode)?;
    Err(delegated_execution_unavailable())
}

/// A permitted invoke parked by the test hold, replayed by [`drain`].
#[cfg(test)]
struct QueuedInvoke {
    org: OrganizationId,
    resolved: ResolvedInvocation,
    invoke_input: InvokeInput,
    constrained_http: Option<ConstrainedHttpInput>,
    authority_hold: Option<InvokeBudgetHold>,
    level: u8,
}

#[cfg(test)]
pub(super) fn hold_next_invoke() {
    hold::arm();
}

#[cfg(test)]
pub(super) fn fixture_work() -> u64 {
    hold::fixture_work()
}

pub(super) async fn dispatch_or_hold(
    st: &AppState,
    org: OrganizationId,
    resolved: ResolvedInvocation,
    invoke_input: InvokeInput,
    constrained_http: Option<ConstrainedHttpInput>,
    authority_hold: Option<InvokeBudgetHold>,
    level: u8,
) -> Response {
    #[cfg(test)]
    if hold::take() {
        hold::push(QueuedInvoke {
            org,
            resolved,
            invoke_input,
            constrained_http,
            authority_hold,
            level,
        });
        return (
            StatusCode::ACCEPTED,
            Json(json!({"queued": true, "outcome": "held"})),
        )
            .into_response();
    }
    finish_dispatch(
        st,
        org,
        resolved,
        invoke_input,
        constrained_http,
        authority_hold,
        level,
    )
    .await
}

#[cfg(test)]
pub(super) async fn drain(st: &AppState) -> Response {
    let Some(job) = hold::pop() else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "no_queued_invoke"})),
        )
            .into_response();
    };
    finish_dispatch(
        st,
        job.org,
        job.resolved,
        job.invoke_input,
        job.constrained_http,
        job.authority_hold,
        job.level,
    )
    .await
}

/// Re-check live delegation and the grant window at the side-effect boundary.
async fn reauthorize(
    st: &AppState,
    resolved: &ResolvedInvocation,
    subject: &str,
) -> Result<(), Response> {
    let child_grant =
        resolved.grant.parent_grant_id.is_some() || resolved.grant.delegation_depth != 0;
    if !resolved.broker_connection {
        if child_grant || resolved.spend_budget.is_some() {
            return Err(delegated_execution_unavailable());
        }
        return Ok(());
    }
    if child_grant && resolved.spend_budget.is_none() {
        return Err(delegated_execution_unavailable());
    }
    if let Some(delegation_id) = &resolved.spend_budget {
        let live = st
            .connection_broker
            .find_live_delegation(subject, &resolved.connection_id.to_string())
            .await;
        let Ok(Some(live)) = live else {
            return Err(not_found());
        };
        require_delegated_mode(live.execution_mode)?;
        if live.delegation_id != *delegation_id || live.grant.id != resolved.grant.id {
            return Err(not_found());
        }
    }
    if resolved.grant.assert_active(Utc::now()).is_err() {
        return Err(not_found());
    }
    Ok(())
}

async fn finish_dispatch(
    st: &AppState,
    org: OrganizationId,
    resolved: ResolvedInvocation,
    invoke_input: InvokeInput,
    constrained_http: Option<ConstrainedHttpInput>,
    authority_hold: Option<InvokeBudgetHold>,
    level: u8,
) -> Response {
    if let Err(response) = reauthorize(st, &resolved, &invoke_input.subject).await {
        release_authority_budget_hold(st, authority_hold).await;
        return response;
    }
    if let Err(response) = ensure_effect_allowed(
        st,
        &resolved,
        constrained_http.is_some(),
        authority_hold.is_none(),
    ) {
        release_authority_budget_hold(st, authority_hold).await;
        return response;
    }
    #[cfg(test)]
    hold::record_side_effect();
    let replay = if authority_hold.is_none() {
        invocation_budget_binding(st, &invoke_input)
            .ok()
            .map(|fingerprint| (invoke_input.intent.idempotency_key.clone(), fingerprint))
    } else {
        None
    };
    // A request without its own hold is a replay, even if the stored intent
    // disappears while it waits: it must never fall through to new work.
    let replay_only = authority_hold.is_none();
    // Open from the persisted intent on replay so the digest matches the stored
    // receipt. A freshly minted nonce must not change the disclosed opening.
    let opening_intent = if replay_only {
        match st
            .db
            .find_idempotent_intent(&org, &invoke_input.intent.idempotency_key)
            .await
        {
            Ok(Some(record)) => record.intent,
            _ => invoke_input.intent.clone(),
        }
    } else {
        invoke_input.intent.clone()
    };
    let opening_digest = match opening_intent.digest() {
        Ok(digest) => digest,
        Err(_) => {
            release_authority_budget_hold(st, authority_hold).await;
            return opening_unavailable();
        }
    };
    if st
        .broker
        .signer
        .intent_commitment(&opensesame_domain::InvocationId::new(), &opening_digest)
        .is_err()
    {
        release_authority_budget_hold(st, authority_hold).await;
        return opening_unavailable();
    }
    let result = execute_invocation(
        st,
        org,
        &resolved,
        invoke_input,
        constrained_http,
        replay_only,
    )
    .await;
    match result {
        Ok(receipt) => {
            let mut body = match super::super::receipts::private_receipt_body(
                st,
                &receipt,
                &opening_digest,
                &opening_intent,
            ) {
                Ok(body) => body,
                Err(response) => {
                    // The effect and receipt are already durable. Do not release
                    // the idempotency claim: a same-key retry must replay it.
                    // A new key is a different request and is not started here.
                    settle_completed_invoke(st, &org, replay, authority_hold).await;
                    return response;
                }
            };
            let Some(obj) = body.as_object_mut() else {
                settle_completed_invoke(st, &org, replay, authority_hold).await;
                return opening_unavailable();
            };
            if let Some(connection_ref) = &st.connection_ref {
                obj.insert("connection_ref".into(), json!(connection_ref.handle.uri()));
            }
            obj.insert("invoke_level".into(), json!(level));
            obj.insert("credential_bytes_returned".into(), json!(false));
            settle_completed_invoke(st, &org, replay, authority_hold).await;
            super::super::receipts::private_response(StatusCode::OK, body)
        }
        Err(error) => {
            settle_authority_budget_hold(st, authority_hold).await;
            let msg = opensesame_redaction::redact_text(&error.to_string());
            (
                StatusCode::FORBIDDEN,
                Json(json!({"error": msg, "type": "about:blank"})),
            )
                .into_response()
        }
    }
}

async fn settle_completed_invoke(
    st: &AppState,
    org: &OrganizationId,
    replay: Option<(String, String)>,
    authority_hold: Option<InvokeBudgetHold>,
) {
    if let Some((key, fingerprint)) = replay {
        settle_replayed_invoke(st, &org.to_string(), &key, &fingerprint).await;
    }
    settle_authority_budget_hold(st, authority_hold).await;
}

fn opening_unavailable() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({"error":"receipt_opening_unavailable"})),
    )
        .into_response()
}

#[cfg(test)]
mod hold {
    use super::QueuedInvoke;
    use std::cell::{Cell, RefCell};

    thread_local! {
        static HOLD: Cell<bool> = const { Cell::new(false) };
        static QUEUE: RefCell<Vec<QueuedInvoke>> = const { RefCell::new(Vec::new()) };
        static FIXTURE_WORK: Cell<u64> = const { Cell::new(0) };
    }

    pub fn arm() {
        HOLD.with(|flag| flag.set(true));
        QUEUE.with(|queue| queue.borrow_mut().clear());
        FIXTURE_WORK.with(|count| count.set(0));
    }

    pub fn take() -> bool {
        HOLD.with(|flag| flag.replace(false))
    }

    pub fn push(job: QueuedInvoke) {
        QUEUE.with(|queue| queue.borrow_mut().push(job));
    }

    pub fn pop() -> Option<QueuedInvoke> {
        QUEUE.with(|queue| queue.borrow_mut().pop())
    }

    pub fn record_side_effect() {
        FIXTURE_WORK.with(|count| count.set(count.get() + 1));
    }

    pub fn fixture_work() -> u64 {
        FIXTURE_WORK.with(Cell::get)
    }
}
