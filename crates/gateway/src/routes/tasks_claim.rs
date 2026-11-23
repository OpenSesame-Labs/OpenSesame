//! Consume only a frozen intent authorized for this caller and grant.

use super::*;

#[derive(serde::Serialize)]
struct RecoveryEnvelope<'a> {
    intent: &'a Value,
    intent_digest: &'a str,
}

/// Give the owner the digest input and future receipt handle before the
/// single-use invocation, so a lost response can be recovered privately.
pub(super) fn frozen_response(intent: &FrozenIntentV2) -> Result<Response, Response> {
    let mut canonical = serde_json::to_value(intent).map_err(|_| internal("intent encoding"))?;
    let object = canonical
        .as_object_mut()
        .ok_or_else(|| internal("intent encoding"))?;
    object.remove("intent_digest");
    let recovery_size = serde_json::to_vec(&RecoveryEnvelope {
        intent: &canonical,
        intent_digest: &intent.intent_digest,
    })
    .map_err(|_| internal("intent encoding"))?
    .len();
    if recovery_size > super::super::tasks_opening::MAX_RECOVERY_BODY_BYTES {
        return Err(err_json(
            StatusCode::PAYLOAD_TOO_LARGE,
            "frozen_intent_too_large",
            "the frozen intent exceeds the recovery limit",
        ));
    }
    let receipt_id = opensesame_domain::ReceiptId::from_uuid(intent.id.as_uuid());
    Ok(super::super::receipts::private_response(
        StatusCode::CREATED,
        json!({
            "intent_id": intent.id.to_string(),
            "intent_digest": &intent.intent_digest,
            "task_run_id": intent.task_run_id.to_string(),
            "task_state_version": intent.task_state_version,
            "canonical_arguments": &intent.canonical_arguments,
            "receipt_id": receipt_id.to_string(),
            "intent": canonical,
        }),
    ))
}

/// Execute a frozen intent under its task ceiling.
///
/// The legacy `/api/v1/intents` path builds an intent from whatever the caller
/// sends, so a task-bound caller that used it spent no ceiling at all. Here the
/// digest names bytes the server already holds, and the broker re-asserts the
/// capability, task state version, and ceiling before anything executes.
/// Take a frozen intent for the caller, spending it only when it is theirs.
///
/// Single use: a spent digest cannot be replayed into a second invocation. The
/// ownership question is settled before the digest is spent — removing first
/// would let anyone who learned a digest burn another principal's intent and
/// collect a 404 for it, leaving the owner with nothing to invoke.
///
/// An intent that is absent and one that belongs to someone else are the same
/// answer here, so a caller cannot use this to enumerate other principals' work.
pub(super) fn claim_frozen_intent(
    pending: &mut std::collections::HashMap<String, FrozenIntentV2>,
    digest: &str,
    caller: &crate::middleware::auth::Caller,
    execution_grant: &Grant,
    now: opensesame_time::DateTime<Utc>,
) -> Result<Option<FrozenIntentV2>, ()> {
    pending.retain(|_, i| i.expires_at > now);
    let Some(intent) = pending.get(digest) else {
        return Ok(None);
    };
    if !caller.owns(&intent.principal_id) || !caller.in_organization(&intent.organization_id) {
        return Ok(None);
    }
    if execution_grant.parent_grant_id.is_some()
        || execution_grant.delegation_depth != 0
        || opensesame_broker::assert_grant_covers_frozen_intent(execution_grant, intent).is_err()
    {
        return Err(());
    }
    Ok(pending.remove(digest))
}
