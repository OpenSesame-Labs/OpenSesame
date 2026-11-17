use opensesame_sql::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use opensesame_sql::{query, query_scalar, SqlitePool};

#[tokio::test]
async fn bundled_sqlite_is_fixed_and_persists_wal_transactions() {
    let directory = tempfile::tempdir().expect("temporary database directory");
    let path = directory.path().join("host.sqlite");
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options.clone())
        .await
        .expect("open bundled SQLite");
    let version: String = query_scalar("select sqlite_version()")
        .fetch_one(&pool)
        .await
        .expect("SQLite version");
    println!("Bundled SQLite: {version}");
    let mut parts = version.split('.').map(|part| part.parse::<u32>().unwrap());
    let (major, minor, patch) = (
        parts.next().unwrap(),
        parts.next().unwrap(),
        parts.next().unwrap(),
    );
    assert!(
        (major, minor, patch) >= (3, 54, 0),
        "SQLite {version} is vulnerable"
    );
    assert!(
        parts.next().is_none(),
        "unexpected SQLite version {version}"
    );
    let mode: String = query_scalar("pragma journal_mode")
        .fetch_one(&pool)
        .await
        .expect("read journal mode");
    assert_eq!(mode, "wal");
    query("create table entries (value text not null)")
        .execute(&pool)
        .await
        .expect("create table");
    query("insert into entries (value) values ('known value')")
        .execute(&pool)
        .await
        .expect("write transaction");
    pool.close().await;
    let reopened = SqlitePool::connect_with(options)
        .await
        .expect("reopen database");
    let value: String = query_scalar("select value from entries")
        .fetch_one(&reopened)
        .await
        .expect("read persisted transaction");
    assert_eq!(value, "known value");
    reopened.close().await;
}
