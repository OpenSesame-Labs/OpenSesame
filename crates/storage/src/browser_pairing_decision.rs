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
        membership_incarnation=(SELECT membership_incarnation FROM host_membership_current
            WHERE principal_id=? AND organization_id=?),
        authority_revision=(SELECT authority_revision FROM host_membership_current
            WHERE principal_id=? AND organization_id=?),
        identity_required=(EXISTS(SELECT 1 FROM host_membership_withdrawals w
            WHERE w.principal_id=? AND w.organization_id=?) OR EXISTS(
            SELECT 1 FROM host_membership_current c WHERE c.principal_id=? AND c.organization_id=?))
        WHERE user_code_digest=? AND state='pending' AND expires_at>?
        RETURNING capabilities_json",
    )
    .bind(if approve { "approved" } else { "denied" })
    .bind(principal)
    .bind(org)
    .bind(now)
    .bind(principal)
    .bind(org)
    .bind(principal)
    .bind(org)
    .bind(principal)
    .bind(org)
    .bind(principal)
    .bind(org)
    .bind(code_digest)
    .bind(now)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(capabilities)
}
