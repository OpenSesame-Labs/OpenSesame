use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

async fn file_db() -> (tempfile::NamedTempFile, Db) {
    let file = tempfile::NamedTempFile::new().unwrap();
    let url = format!("sqlite:{}", file.path().display());
    let db = Db::connect_sqlite(&url).await.unwrap();
    (file, db)
}

fn document(names: &[&str]) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "owner": HOST_TRUST_OWNER,
        "actor": "operator@example.test",
        "change_ref": "change-123",
        "names": names,
    }))
    .unwrap()
}

fn names(values: &[&str]) -> BTreeSet<TrustProfileRef> {
    values
        .iter()
        .map(|name| TrustProfileRef::new(*name).unwrap())
        .collect()
}

#[tokio::test]
async fn missing_requires_one_explicit_attestation_and_never_overwrites() {
    let (_file, db) = file_db().await;
    assert!(matches!(load(&db).await, Err(HistoryError::Missing)));
    assert!(matches!(
        union(&db, &names(&["a.test"])).await,
        Err(HistoryError::Missing)
    ));
    assert!(matches!(
        initialize(&db, &document(&[]), false).await,
        Err(HistoryError::NotAttested)
    ));
    assert!(matches!(load(&db).await, Err(HistoryError::Missing)));

    let first_document = document(&["b.test", "a.test"]);
    let second_document = document(&["different.test"]);
    let (first, second) = tokio::join!(
        initialize(&db, &first_document, true),
        initialize(&db, &second_document, true),
    );
    let (accepted, refused) = match first {
        Ok(accepted) => (accepted, second),
        Err(error) => (second.unwrap(), Err(error)),
    };
    assert!(matches!(refused, Err(HistoryError::AlreadyInitialized)));
    assert_eq!(load(&db).await.unwrap(), accepted);
    assert!(matches!(
        initialize(&db, &document(&[]), true).await,
        Err(HistoryError::AlreadyInitialized)
    ));
    assert_eq!(load(&db).await.unwrap(), accepted);
}

#[tokio::test]
async fn rejects_untrusted_attestations_without_creating_a_row() {
    let (_file, db) = file_db().await;
    let bad = [
        serde_json::json!({"owner":"other", "actor":"a", "change_ref":"c", "names":[]}),
        serde_json::json!({"owner":HOST_TRUST_OWNER, "actor":" ", "change_ref":"c", "names":[]}),
        serde_json::json!({"owner":HOST_TRUST_OWNER, "actor":"a", "change_ref":"c\n", "names":[]}),
        serde_json::json!({"owner":HOST_TRUST_OWNER, "actor":"a", "change_ref":"c", "names":["INVALID"]}),
        serde_json::json!({"owner":HOST_TRUST_OWNER, "actor":"a", "change_ref":"c", "names":["x", "x"]}),
        serde_json::json!({"owner":HOST_TRUST_OWNER, "actor":"a", "change_ref":"c", "names":[], "extra":true}),
    ];
    for value in bad {
        assert!(matches!(
            initialize(&db, &serde_json::to_vec(&value).unwrap(), true).await,
            Err(HistoryError::Invalid(_))
        ));
        assert!(matches!(load(&db).await, Err(HistoryError::Missing)));
    }
    assert!(matches!(
        initialize(&db, &vec![b'x'; MAX_BYTES + 1], true).await,
        Err(HistoryError::Invalid(_))
    ));
    assert!(matches!(load(&db).await, Err(HistoryError::Missing)));
}

#[tokio::test]
async fn refuses_memory_or_unsafe_sqlite_durability_settings() {
    let memory = Db::connect_memory().await.unwrap();
    assert!(matches!(
        initialize(&memory, &document(&[]), true).await,
        Err(HistoryError::Invalid("SQLite durability settings"))
    ));
    assert!(memory.get_host_kv(KEY).await.unwrap().is_none());

    let (_file, db) = file_db().await;
    let mut connection = db.pool().acquire().await.unwrap();
    sqlx::query("PRAGMA main.synchronous = OFF")
        .execute(&mut *connection)
        .await
        .unwrap();
    assert!(matches!(
        checked_cas_on_connection(&mut connection, None, "{}").await,
        Err(HistoryError::Invalid("SQLite durability settings"))
    ));
    sqlx::query("PRAGMA main.synchronous = FULL")
        .execute(&mut *connection)
        .await
        .unwrap();
    sqlx::query("PRAGMA main.journal_mode = OFF")
        .execute(&mut *connection)
        .await
        .unwrap();
    assert!(matches!(
        checked_cas_on_connection(&mut connection, None, "{}").await,
        Err(HistoryError::Invalid("SQLite durability settings"))
    ));
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM main.host_kv WHERE key = ?")
        .bind(KEY)
        .fetch_one(&mut *connection)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn temp_shadow_cannot_divert_reads_or_conditional_writes_from_main() {
    let (_file, db) = file_db().await;
    let mut connection = db.pool().acquire().await.unwrap();
    sqlx::query("CREATE TEMP TABLE host_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)")
        .execute(&mut *connection)
        .await
        .unwrap();
    sqlx::query("INSERT INTO temp.host_kv (key, value, updated_at) VALUES (?, 'shadow', '')")
        .bind(KEY)
        .execute(&mut *connection)
        .await
        .unwrap();
    assert!(matches!(
        read_on_connection(&mut connection).await,
        Err(HistoryError::Missing)
    ));
    assert!(checked_cas_on_connection(&mut connection, None, "first")
        .await
        .unwrap());
    assert_eq!(read_on_connection(&mut connection).await.unwrap(), "first");
    assert!(
        !checked_cas_on_connection(&mut connection, Some("shadow"), "wrong")
            .await
            .unwrap()
    );
    assert!(
        checked_cas_on_connection(&mut connection, Some("first"), "second")
            .await
            .unwrap()
    );
    assert_eq!(read_on_connection(&mut connection).await.unwrap(), "second");
    let shadow: String = sqlx::query_scalar("SELECT value FROM temp.host_kv WHERE key = ?")
        .bind(KEY)
        .fetch_one(&mut *connection)
        .await
        .unwrap();
    assert_eq!(shadow, "shadow");
}

#[tokio::test]
async fn sqlite_restart_keeps_the_union_after_a_write_before_activation() {
    let file = tempfile::NamedTempFile::new().unwrap();
    let url = format!("sqlite:{}", file.path().display());
    let db = Db::connect_sqlite(&url).await.unwrap();
    initialize(&db, &document(&["a.test"]), true).await.unwrap();
    // No manager is activated in this test: this is the crash-after-CAS
    // boundary, not evidence of the eventual source integration.
    let written = union(&db, &names(&["b.test"])).await.unwrap();
    assert_eq!(written.revision(), 2);
    db.pool().close().await;
    drop(db);

    let reopened = Db::connect_sqlite(&url).await.unwrap();
    let restored = load(&reopened).await.unwrap();
    assert_eq!(restored.names(), names(&["a.test", "b.test"]));
    assert_eq!(restored.revision(), 2);
    let unchanged = union(&reopened, &names(&["a.test"])).await.unwrap();
    assert_eq!(unchanged.revision(), 2);
    assert_eq!(unchanged.names(), restored.names());
}

async fn wait_for_initial_attempt(wait: bool, barrier: Arc<tokio::sync::Barrier>) {
    if wait {
        barrier.wait().await;
    }
}

#[tokio::test]
async fn contended_writers_retry_from_the_winning_union() {
    let file = tempfile::NamedTempFile::new().unwrap();
    let url = format!("sqlite:{}", file.path().display());
    let first = Db::connect_sqlite(&url).await.unwrap();
    let second = Db::connect_sqlite(&url).await.unwrap();
    initialize(&first, &document(&["a.test"]), true)
        .await
        .unwrap();

    // Both reads complete before either conditional write. One must lose and
    // retry the actual production loop from the winning record.
    let barrier = Arc::new(tokio::sync::Barrier::new(2));
    let attempts = Arc::new(AtomicUsize::new(0));
    let make_hook = || {
        let barrier = Arc::clone(&barrier);
        let attempts = Arc::clone(&attempts);
        let mut first_attempt = true;
        move || {
            let wait = first_attempt;
            first_attempt = false;
            attempts.fetch_add(1, Ordering::SeqCst);
            wait_for_initial_attempt(wait, Arc::clone(&barrier))
        }
    };
    let b = names(&["b.test"]);
    let c = names(&["c.test"]);
    let (b_result, c_result) = tokio::join!(
        union_with_hook(&first, &b, make_hook()),
        union_with_hook(&second, &c, make_hook()),
    );
    b_result.unwrap();
    c_result.unwrap();
    assert!(attempts.load(Ordering::SeqCst) >= 3);
    let final_history = load(&first).await.unwrap();
    assert_eq!(
        final_history.names(),
        names(&["a.test", "b.test", "c.test"])
    );
    assert_eq!(final_history.revision(), 3);
    assert_eq!(load(&first).await.unwrap(), final_history);
}

#[tokio::test]
async fn corrupt_missing_and_oversized_rows_are_not_empty_history() {
    let (_file, db) = file_db().await;
    let history = initialize(&db, &document(&["a.test"]), true).await.unwrap();
    let mut bad = history.clone();
    bad.complete = false;
    let incomplete = serde_json::to_string(&bad).unwrap();
    bad = history.clone();
    bad.owner = "other".into();
    let wrong_owner = serde_json::to_string(&bad).unwrap();
    bad = history;
    bad.names.push("a.test".into());
    let duplicate = serde_json::to_string(&bad).unwrap();
    for value in [
        "{broken".to_string(),
        incomplete,
        wrong_owner,
        duplicate,
        "x".repeat(MAX_BYTES + 1),
    ] {
        db.set_host_kv(KEY, &value).await.unwrap();
        assert!(matches!(load(&db).await, Err(HistoryError::Invalid(_))));
        assert!(matches!(
            union(&db, &names(&["b.test"])).await,
            Err(HistoryError::Invalid(_))
        ));
        assert_eq!(db.get_host_kv(KEY).await.unwrap().unwrap(), value);
    }
    db.delete_host_kv(KEY).await.unwrap();
    assert!(matches!(load(&db).await, Err(HistoryError::Missing)));
    assert!(matches!(
        union(&db, &names(&["b.test"])).await,
        Err(HistoryError::Missing)
    ));
}

#[tokio::test]
async fn removed_row_during_unchanged_union_is_not_acknowledged() {
    let (_file, db) = file_db().await;
    initialize(&db, &document(&["a.test"]), true).await.unwrap();
    let deleting = db.clone();
    let result = union_with_hook(&db, &names(&["a.test"]), move || {
        let deleting = deleting.clone();
        async move { deleting.delete_host_kv(KEY).await.unwrap() }
    })
    .await;
    assert!(matches!(result, Err(HistoryError::Missing)));
    assert!(matches!(load(&db).await, Err(HistoryError::Missing)));
}

#[tokio::test]
async fn quota_and_invalid_names_do_not_change_existing_history() {
    let (_file, db) = file_db().await;
    initialize(&db, &document(&[]), true).await.unwrap();
    let full: BTreeSet<_> = (0..MAX_NAMES)
        .map(|number| TrustProfileRef::new(format!("td{number}")).unwrap())
        .collect();
    let full_history = union(&db, &full).await.unwrap();
    assert_eq!(full_history.names(), full);
    assert!(matches!(
        union(&db, &names(&["extra.test"])).await,
        Err(HistoryError::Invalid(_))
    ));
    let forged = BTreeSet::from([TrustProfileRef {
        name: "INVALID".into(),
    }]);
    assert!(matches!(
        union(&db, &forged).await,
        Err(HistoryError::Invalid(_))
    ));
    assert_eq!(load(&db).await.unwrap(), full_history);
}

#[tokio::test]
#[ignore = "requires vectors emitted by the checked Lean model"]
async fn lean_vectors_match_durable_history_store() {
    let path = std::env::var("OPENSESAME_SOURCE_HISTORY_VECTORS").unwrap();
    let vectors = std::fs::read_to_string(path).unwrap();
    let domain_names = ["a.test", "b.test", "c.test"];
    let decode = |bits: &str| -> Vec<&str> {
        assert_eq!(bits.len(), domain_names.len());
        bits.bytes()
            .zip(domain_names)
            .filter_map(|(bit, name)| match bit {
                b'1' => Some(name),
                b'0' => None,
                _ => panic!("invalid model vector"),
            })
            .collect()
    };
    let mut seen = BTreeSet::new();
    for line in vectors.lines().filter(|line| line.starts_with("case\t")) {
        let fields: Vec<_> = line.split('\t').collect();
        assert_eq!(fields.len(), 5);
        assert_eq!(fields[0], "case");
        assert!(seen.insert((fields[1].to_owned(), fields[2].to_owned())));
        let (_file, db) = file_db().await;
        initialize(&db, &document(&decode(fields[1])), true)
            .await
            .unwrap();
        let result = union(&db, &names(&decode(fields[2]))).await.unwrap();
        assert_eq!(result.revision(), fields[3].parse::<u64>().unwrap());
        assert_eq!(result.names(), names(&decode(fields[4])));
        assert_eq!(load(&db).await.unwrap(), result);
    }
    assert_eq!(seen.len(), 9, "model must emit all required traces");
}
