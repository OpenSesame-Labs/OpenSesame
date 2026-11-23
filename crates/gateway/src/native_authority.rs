//! Durable, replica-shared authority for opaque native sessions.
//!
//! Cache entries support synchronous route authenticators, but never establish
//! native authority: the request guard reloads this store on every request.
use crate::session_claims::{CredentialKind, HostSessionClaims};
use opensesame_time::Utc;
use sqlx::{Sqlite, SqlitePool, Transaction};

const MAX_NATIVE_SESSIONS: i64 = 1024;

/// A database is one Host authority. Refuse inconsistent replica settings
/// rather than letting device approval or session validation fail randomly.
pub async fn bind_configuration(
    pool: &SqlitePool,
    resource: &str,
    pepper: &str,
) -> anyhow::Result<()> {
    let fingerprint = opensesame_claims::hash_secret(&format!("host-native-pepper:{pepper}"));
    sqlx::query("INSERT OR IGNORE INTO host_native_security_binding(singleton,pepper_fingerprint,resource) VALUES (1,?,?)")
        .bind(&fingerprint).bind(resource).execute(pool).await?;
    let found: (String, String) = sqlx::query_as(
        "SELECT pepper_fingerprint,resource FROM host_native_security_binding WHERE singleton=1",
    )
    .fetch_one(pool)
    .await?;
    anyhow::ensure!(found.0 == fingerprint && found.1 == resource,
        "Host database belongs to a different resource or claim pepper; use matching replica configuration");
    Ok(())
}

/// Publish a session in the caller's write transaction. The grant is consumed
/// in the same transaction, so concurrent redeemers cannot both succeed.
pub async fn insert_session(
    tx: &mut Transaction<'_, Sqlite>,
    digest: &str,
    claims: &HostSessionClaims,
) -> anyhow::Result<bool> {
    let now = Utc::now().timestamp_millis();
    sqlx::query("DELETE FROM host_native_sessions WHERE expires_at <= ?")
        .bind(now)
        .execute(&mut **tx)
        .await?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM host_native_sessions")
        .fetch_one(&mut **tx)
        .await?;
    if count >= MAX_NATIVE_SESSIONS {
        return Ok(false);
    }
    anyhow::ensure!(claims.credential_kind == CredentialKind::NativeSession);
    let revision = claims.membership_revision.as_ref();
    sqlx::query("INSERT INTO host_native_sessions (session_digest,claims_json,expires_at,organization_id,principal_id,membership_incarnation,authority_revision,local_session) VALUES (?,?,?,?,?,?,?,?)")
        .bind(digest)
        .bind(serde_json::to_string(claims)?)
        .bind(claims.expires_at.timestamp_millis())
        .bind(claims.organization_id.to_string())
        .bind(claims.principal_id.to_string())
        .bind(revision.map(|r| r.incarnation.as_str()))
        .bind(revision.map(|r| r.revision.as_str()))
        .bind(claims.local_session)
        .execute(&mut **tx)
        .await?;
    Ok(true)
}

pub async fn mint_local(
    pool: &SqlitePool,
    digest: &str,
    claims: &HostSessionClaims,
) -> anyhow::Result<bool> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let inserted = insert_session(&mut tx, digest, claims).await?;
    tx.commit().await?;
    Ok(inserted)
}

/// Recheck the durable session and its exact Identity withdrawal fence.
pub async fn session(pool: &SqlitePool, digest: &str) -> anyhow::Result<Option<HostSessionClaims>> {
    let json: Option<String> = sqlx::query_scalar(
        "SELECT s.claims_json FROM host_native_sessions s
         WHERE s.session_digest=? AND s.expires_at>?
         AND (s.local_session=1 OR NOT EXISTS (
           SELECT 1 FROM host_membership_withdrawals w
           WHERE w.organization_id=s.organization_id AND w.principal_id=s.principal_id
             AND ((s.membership_incarnation IS NULL AND s.authority_revision IS NULL)
               OR (w.membership_incarnation=s.membership_incarnation AND w.authority_revision=s.authority_revision))))",
    )
    .bind(digest)
    .bind(Utc::now().timestamp_millis())
    .fetch_optional(pool)
    .await?;
    json.map(|value| serde_json::from_str(&value).map_err(Into::into))
        .transpose()
}

/// A revision may be approved or redeemed only before its withdrawal commits.
pub async fn revision_live(
    tx: &mut Transaction<'_, Sqlite>,
    organization: &str,
    principal: &str,
    revision: Option<&crate::session_claims::MembershipRevision>,
) -> anyhow::Result<bool> {
    let count: i64 = if let Some(revision) = revision {
        sqlx::query_scalar("SELECT COUNT(*) FROM host_membership_withdrawals WHERE organization_id=? AND principal_id=? AND membership_incarnation=? AND authority_revision=?")
            .bind(organization).bind(principal).bind(&revision.incarnation).bind(&revision.revision)
            .fetch_one(&mut **tx).await?
    } else {
        sqlx::query_scalar("SELECT COUNT(*) FROM host_membership_withdrawals WHERE organization_id=? AND principal_id=?")
            .bind(organization).bind(principal).fetch_one(&mut **tx).await?
    };
    Ok(count == 0)
}
