//! Atomic persistence of pending device codes and native session exchange.
use crate::{
    app_state::{AppState, ApprovedDevice, DevicePending},
    middleware::auth::same_principal_subject,
    session_claims::HostSessionClaims,
};
use opensesame_claims::{hash_eq, hash_low_entropy, hash_secret};
use opensesame_time::Utc;
use sqlx::Row;

const MAX_PENDING_DEVICE_CODES: i64 = 512;

pub enum Create {
    Inserted,
    Capacity,
    Collision,
}

pub async fn create(
    st: &AppState,
    digest: &str,
    pending: &DevicePending,
    user_code: &str,
) -> anyhow::Result<Create> {
    let mut tx = st.db.pool().begin_with("BEGIN IMMEDIATE").await?;
    sqlx::query("DELETE FROM host_device_codes WHERE expires_at <= ?")
        .bind(Utc::now().timestamp_millis())
        .execute(&mut *tx)
        .await?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM host_device_codes")
        .fetch_one(&mut *tx)
        .await?;
    if count >= MAX_PENDING_DEVICE_CODES {
        tx.commit().await?;
        return Ok(Create::Capacity);
    }
    // A collision must be retried: otherwise an approval can select the wrong
    // device. Compare keyed per-device digests without storing the code itself.
    let existing = sqlx::query("SELECT device_digest,user_code_hash FROM host_device_codes")
        .fetch_all(&mut *tx)
        .await?;
    for row in existing {
        let other_digest: String = row.try_get("device_digest")?;
        let other_hash: String = row.try_get("user_code_hash")?;
        if hash_eq(
            &hash_low_entropy(&st.claim_pepper, &other_digest, user_code),
            &other_hash,
        ) {
            tx.commit().await?;
            return Ok(Create::Collision);
        }
    }
    sqlx::query("INSERT INTO host_device_codes(device_digest,user_code_hash,client_id,scope,expires_at) VALUES (?,?,?,?,?)")
        .bind(digest).bind(&pending.user_code_hash).bind(&pending.client_id).bind(&pending.scope)
        .bind(pending.expires_at.timestamp_millis()).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Create::Inserted)
}

pub enum Exchange {
    Invalid,
    Expired,
    Pending,
    Capacity,
    Granted {
        session_id: String,
        claims: HostSessionClaims,
    },
}

pub async fn exchange(st: &AppState, digest: &str, client_id: &str) -> anyhow::Result<Exchange> {
    // The write transaction is the cross-replica lifecycle fence. Withdrawal,
    // approval, exchange, and publishing the session all serialize through it.
    let mut tx = st.db.pool().begin_with("BEGIN IMMEDIATE").await?;
    let Some(row) = sqlx::query(
        "SELECT client_id,expires_at,approved_json FROM host_device_codes WHERE device_digest=?",
    )
    .bind(digest)
    .fetch_optional(&mut *tx)
    .await?
    else {
        return Ok(Exchange::Invalid);
    };
    let stored_client: String = row.try_get("client_id")?;
    if stored_client != client_id {
        return Ok(Exchange::Invalid);
    }
    if row.try_get::<i64, _>("expires_at")? <= Utc::now().timestamp_millis() {
        return Ok(Exchange::Expired);
    }
    let Some(approval) = row.try_get::<Option<String>, _>("approved_json")? else {
        return Ok(Exchange::Pending);
    };
    let approved: ApprovedDevice = serde_json::from_str(&approval)?;
    let Some(principal) = crate::session_claims::parse_principal(&approved.principal) else {
        return Ok(Exchange::Invalid);
    };
    if approved.membership_revision.is_some()
        && !crate::native_authority::revision_live(
            &mut tx,
            &approved.organization_id.to_string(),
            &principal.to_string(),
            approved.membership_revision.as_ref(),
        )
        .await?
    {
        return Ok(Exchange::Invalid);
    }
    let boot = st.bootstrap.lock().unwrap().clone().filter(|boot| {
        boot.org == approved.organization_id
            && same_principal_subject(&approved.principal, &boot.principal.to_string())
    });
    let session_id = format!("sess_{}", uuid::Uuid::new_v4());
    let session_digest = hash_secret(&session_id);
    let mut claims = HostSessionClaims::operator_approved(
        principal,
        approved.organization_id,
        approved.organization_role,
        stored_client,
        st.resource.clone(),
    );
    claims.actor_id = boot.as_ref().map(|boot| boot.actor);
    claims.project_id = boot.as_ref().map(|boot| boot.project);
    claims.credential_handle = boot
        .as_ref()
        .map(|_| format!("handle_{}", uuid::Uuid::new_v4()));
    claims.membership_revision = approved.membership_revision;
    claims.local_session = claims.membership_revision.is_none();
    if !crate::native_authority::insert_session(&mut tx, &session_digest, &claims).await? {
        tx.commit().await?;
        return Ok(Exchange::Capacity);
    }
    sqlx::query("DELETE FROM host_device_codes WHERE device_digest=?")
        .bind(digest)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Exchange::Granted { session_id, claims })
}
