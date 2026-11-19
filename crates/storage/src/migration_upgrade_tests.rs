//! Append-only upgrades preserve the previous journal and roll back failed DDL.
use super::*;

#[path = "agent_hook_records_fk_tests.rs"]
mod agent_hook_records_fk_tests;
#[path = "bitwarden_upgrade_tests.rs"]
mod bitwarden_upgrade_tests;

async fn previous_schema() -> Db {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    apply_migrations(&pool, &MIGRATIONS[..25]).await;
    sqlx::query(
        "CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
    )
    .execute(&pool)
    .await
    .unwrap();
    for (version, _) in &MIGRATIONS[..25] {
        sqlx::query("INSERT INTO schema_migrations VALUES (?, 'previous-boot')")
            .bind(version)
            .execute(&pool)
            .await
            .unwrap();
    }
    Db { pool }
}

#[tokio::test]
async fn upgrade_from_0025_preserves_journal_and_is_idempotent() {
    let db = previous_schema().await;
    db.migrate().await.unwrap();
    assert_eq!(db.applied_migrations().await.unwrap(), migration_versions());
    let preserved: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM schema_migrations WHERE applied_at = 'previous-boot'",
    )
    .fetch_one(db.pool())
    .await
    .unwrap();
    assert_eq!(preserved, 25);
    let journal: Vec<(String, String)> =
        sqlx::query_as("SELECT version, applied_at FROM schema_migrations ORDER BY version")
            .fetch_all(db.pool())
            .await
            .unwrap();
    db.migrate().await.unwrap();
    let repeated: Vec<(String, String)> =
        sqlx::query_as("SELECT version, applied_at FROM schema_migrations ORDER BY version")
            .fetch_all(db.pool())
            .await
            .unwrap();
    assert_eq!(journal, repeated);
}

#[tokio::test]
async fn failed_append_rolls_back_schema_and_journal_then_retries() {
    let db = previous_schema().await;
    // Collision at the second table of 0032 forces failure after its first DDL.
    sqlx::query("CREATE TABLE config_project_access (sentinel INTEGER)")
        .execute(db.pool())
        .await
        .unwrap();
    assert!(db.migrate().await.is_err());
    assert_eq!(db.applied_migrations().await.unwrap().len(), 31);
    let partial: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'config_authorization_roles'",
    )
    .fetch_one(db.pool())
    .await
    .unwrap();
    assert_eq!(partial, 0);
    sqlx::query("DROP TABLE config_project_access")
        .execute(db.pool())
        .await
        .unwrap();
    db.migrate().await.unwrap();
    assert_eq!(db.applied_migrations().await.unwrap(), migration_versions());
}

#[tokio::test]
async fn upgrade_from_pairing_revision_adds_agent_membership_authority() {
    let upto_native = MIGRATIONS
        .iter()
        .position(|(version, _)| *version == "0062_host_native_authority")
        .unwrap();
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    apply_migrations(&pool, &MIGRATIONS[..upto_native]).await;
    sqlx::query(
        "CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
    )
    .execute(&pool)
    .await
    .unwrap();
    for (version, _) in &MIGRATIONS[..upto_native] {
        sqlx::query("INSERT INTO schema_migrations VALUES (?, 'previous-boot')")
            .bind(version)
            .execute(&pool)
            .await
            .unwrap();
    }
    sqlx::query(
        "INSERT INTO agent_launches
         (handle_digest,principal_id,organization_id,client_id,audience,resource,
          capabilities_json,approved_at,expires_at)
         VALUES ('legacy','principal','org','client','audience','resource','[]',1,301)",
    )
    .execute(&pool)
    .await
    .unwrap();
    let db = Db { pool };
    db.migrate().await.unwrap();
    let columns: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM pragma_table_info('agent_launches')
         WHERE name IN ('membership_incarnation','authority_revision') ORDER BY name",
    )
    .fetch_all(db.pool())
    .await
    .unwrap();
    assert_eq!(columns, ["authority_revision", "membership_incarnation"]);
    assert!(db
        .withdraw_host_membership(&crate::host_membership::MembershipWithdrawal {
            withdrawal_id: "withdrawal",
            organization_id: "org",
            principal_id: "principal",
            membership_incarnation: "incarnation",
            authority_revision: "revision",
        })
        .await
        .unwrap());
    let revoked: i64 =
        sqlx::query_scalar("SELECT revoked FROM agent_launches WHERE handle_digest='legacy'")
            .fetch_one(db.pool())
            .await
            .unwrap();
    assert_eq!(revoked, 1);
}
