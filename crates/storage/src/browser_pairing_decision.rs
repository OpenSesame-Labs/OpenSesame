use sqlx::{Sqlite, Transaction};

/// Record at most one decision in the caller's transaction.
/// # Errors
/// A storage failure leaves the transaction uncommitted.
pub async fn decide_browser_pairing_in_transaction(
    tx: &mut Transaction<'_, Sqlite>,
    code_digest: &str,
    principal: &str,
    org: &str,
    approve: bool,
    now: i64,
) -> anyhow::Result<Option<String>> {
    let capabilities = sqlx::query_scalar(
        "UPDATE browser_pairings SET state=?,principal_id=?,organization_id=?,approved_at=?,
        identity_required=EXISTS(SELECT 1 FROM host_membership_withdrawals w
            WHERE w.principal_id=? AND w.organization_id=?)
        WHERE user_code_digest=? AND state='pending' AND expires_at>?
        RETURNING capabilities_json",
    )
    .bind(if approve { "approved" } else { "denied" })
    .bind(principal)
    .bind(org)
    .bind(now)
    .bind(principal)
    .bind(org)
    .bind(code_digest)
    .bind(now)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(capabilities)
}
