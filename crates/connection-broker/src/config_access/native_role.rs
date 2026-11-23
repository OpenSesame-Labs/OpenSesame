use opensesame_domain::{OrganizationId, OrganizationRole, PrincipalId};
use opensesame_time::Utc;
use sqlx::{Sqlite, SqlitePool, Transaction};

/// Initialize a native ceiling and its audit event inside the caller's transaction.
/// Existing ceilings, including revocations, are never raised by another approval.
/// # Errors
/// Any database failure aborts the caller's approval transaction.
pub async fn provision_native_role_in_transaction(
    tx: &mut Transaction<'_, Sqlite>,
    organization: &OrganizationId,
    principal: &PrincipalId,
    role: OrganizationRole,
) -> anyhow::Result<()> {
    let existing: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM config_authorization_roles WHERE organization_id=? AND principal_id=?",
    )
    .bind(organization.to_string())
    .bind(principal.to_string())
    .fetch_optional(&mut **tx)
    .await?;
    if existing.is_some() {
        return Ok(());
    }
    let inserted = sqlx::query(
        "INSERT OR IGNORE INTO config_authorization_roles
        (organization_id,principal_id,role,revision,evidence_after) VALUES (?,?,?,1,0)",
    )
    .bind(organization.to_string())
    .bind(principal.to_string())
    .bind(super::role_text(role))
    .execute(&mut **tx)
    .await?
    .rows_affected();
    if inserted == 1 {
        let payload = serde_json::json!({"organization_id":organization.to_string(),
            "principal_id":principal.to_string(),"revision":1})
        .to_string();
        sqlx::query(
            "INSERT INTO outbox_events(id,event_type,payload_json,created_at) VALUES(?,?,?,?)",
        )
        .bind(uuid::Uuid::now_v7().to_string())
        .bind("config.authorization.role_changed")
        .bind(opensesame_event_seal::seal(
            "outbox_events.payload_json",
            &payload,
        ))
        .bind(Utc::now().to_rfc3339())
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

/// Initialize policy only during explicit native approval.
/// # Errors
/// Returns database failures; an unsuccessful transaction changes nothing.
pub async fn provision_native_role(
    pool: &SqlitePool,
    organization: &OrganizationId,
    principal: &PrincipalId,
    role: OrganizationRole,
) -> anyhow::Result<()> {
    // Serialize first-time approvals so competing requests observe the same
    // stored ceiling instead of racing a read followed by an insert.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    provision_native_role_in_transaction(&mut tx, organization, principal, role).await?;
    tx.commit().await?;
    Ok(())
}
