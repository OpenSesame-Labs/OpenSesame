use super::*;
use crate::transport::source_history::{initialize, load};

#[cfg(unix)]
#[tokio::test]
async fn duplicate_host_claim_preserves_the_sqlite_write_lock() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite:{}?mode=rwc",
        directory.path().join("host.db").display()
    );
    let options = super::super::file_lock::claim_url(&url, false, true)
        .unwrap()
        .unwrap();
    let pool = sqlx::SqlitePool::connect_with(options).await.unwrap();
    let mut connection = pool.acquire().await.unwrap();
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *connection)
        .await
        .unwrap();
    assert!(super::super::file_lock::claim_url(&url, false, true).is_err());

    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "transport::source_history::coordinator::tests::sqlite_writer_child",
            "--ignored",
            "--nocapture",
        ])
        .env("HISTORY_SQLITE_WRITER_DB", &url)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(
                status.success(),
                "competing SQLite writer was not fenced: {status}"
            );
            break;
        }
        if std::time::Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("competing SQLite writer did not finish");
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    sqlx::query("ROLLBACK")
        .execute(&mut *connection)
        .await
        .unwrap();
    drop(connection);
    pool.close().await;
}

#[cfg(unix)]
#[test]
#[ignore = "spawned explicitly by the SQLite lock control"]
fn sqlite_writer_child() {
    let Ok(url) = std::env::var("HISTORY_SQLITE_WRITER_DB") else {
        return;
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        let mut connection = pool.acquire().await.unwrap();
        sqlx::query("PRAGMA busy_timeout = 0")
            .execute(&mut *connection)
            .await
            .unwrap();
        assert!(sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *connection)
            .await
            .is_err());
    });
}

#[tokio::test]
async fn successor_waits_until_a_detached_write_has_a_known_outcome() {
    let scope = Arc::new(Scope::default());
    let first = acquire(Arc::clone(&scope)).await.unwrap();
    let mut pending = PendingWrite::new(first.hold());
    drop(first);
    let mut successor = Box::pin(acquire(Arc::clone(&scope)));
    assert!(futures::poll!(successor.as_mut()).is_pending());
    pending.finish();
    drop(pending);
    let second = successor.await.unwrap();
    drop(second);
    assert!(!scope.poisoned.load(Ordering::SeqCst));
}

#[tokio::test]
async fn dropping_an_unresolved_write_poison_fences_the_next_owner() {
    let scope = Arc::new(Scope::default());
    let first = acquire(Arc::clone(&scope)).await.unwrap();
    let pending = PendingWrite::new(first.hold());
    drop(first);
    let mut successor = Box::pin(acquire(Arc::clone(&scope)));
    assert!(futures::poll!(successor.as_mut()).is_pending());
    drop(pending);
    assert!(matches!(successor.await, Err(HistoryError::Poisoned)));
    assert!(scope.poisoned.load(Ordering::SeqCst));
    assert!(matches!(acquire(scope).await, Err(HistoryError::Poisoned)));
}

#[tokio::test]
#[ignore = "requires vectors emitted by the checked Lean model"]
async fn lean_vectors_match_real_owner_and_pending_write_guards() {
    let path = std::env::var("OPENSESAME_SOURCE_HISTORY_VECTORS").unwrap();
    let vectors = std::fs::read_to_string(path).unwrap();
    let mut seen = BTreeSet::new();
    for line in vectors.lines().filter(|line| line.starts_with("coord\t")) {
        let fields: Vec<_> = line.split('\t').collect();
        assert_eq!(fields.len(), 4);
        let pending = match fields[1] {
            "0" => false,
            "1" => true,
            _ => panic!("invalid pending bit"),
        };
        let poisoned = match fields[2] {
            "0" => false,
            "1" => true,
            _ => panic!("invalid poison bit"),
        };
        let expected = match fields[3] {
            "0" => false,
            "1" => true,
            _ => panic!("invalid expected bit"),
        };
        assert!(seen.insert((pending, poisoned)));
        let scope = Arc::new(Scope::default());
        let first = acquire(Arc::clone(&scope)).await.unwrap();
        let mut write = pending.then(|| PendingWrite::new(first.hold()));
        if poisoned {
            scope.poisoned.store(true, Ordering::SeqCst);
        }
        drop(first);
        let mut successor = Box::pin(acquire(Arc::clone(&scope)));
        let actual = matches!(
            futures::poll!(successor.as_mut()),
            std::task::Poll::Ready(Ok(_))
        );
        assert_eq!(actual, expected, "{line}");
        if let Some(pending_write) = &mut write {
            pending_write.finish();
        }
        drop(write);
    }
    assert_eq!(seen.len(), 4, "model must emit all owner-guard cases");
}

#[tokio::test]
async fn explicit_initialization_and_recovery_both_require_an_owner_lease() {
    let file = tempfile::NamedTempFile::new().unwrap();
    let url = format!("sqlite:{}", file.path().display());
    let db = Db::connect_sqlite(&url).await.unwrap();
    let document =
        br#"{"owner":"host-tls","actor":"operator","change_ref":"change-1","names":["a.test"]}"#;
    let scope = Arc::new(Scope::default());
    let first = acquire(Arc::clone(&scope)).await.unwrap();
    assert!(matches!(
        first
            .start_manager(db.clone(), GenerationCandidate::default())
            .await,
        Err(HistoryError::Missing)
    ));
    let first = acquire(Arc::clone(&scope)).await.unwrap();
    assert!(matches!(
        first.initialize(db.clone(), document.to_vec(), false).await,
        Err(HistoryError::NotAttested)
    ));
    let first = acquire(Arc::clone(&scope)).await.unwrap();
    first
        .initialize(db.clone(), document.to_vec(), true)
        .await
        .unwrap();
    let first = acquire(Arc::clone(&scope)).await.unwrap();
    assert!(matches!(
        first.initialize(db.clone(), document.to_vec(), true).await,
        Err(HistoryError::AlreadyInitialized)
    ));
    let successor = acquire(scope).await.unwrap();
    let managed = successor
        .start_manager(db, GenerationCandidate::default())
        .await
        .unwrap();
    assert!(managed
        .generations()
        .source_trust(1)
        .unwrap()
        .unwrap()
        .reserved
        .contains(&TrustProfileRef::new("a.test").unwrap()));
}

#[tokio::test]
async fn every_manager_arc_keeps_the_exclusive_owner_slot() {
    let file = tempfile::NamedTempFile::new().unwrap();
    let url = format!("sqlite:{}", file.path().display());
    let db = Db::connect_sqlite(&url).await.unwrap();
    let document = br#"{"owner":"host-tls","actor":"operator","change_ref":"change-1","names":[]}"#;
    initialize(&db, document, true).await.unwrap();
    let scope = Arc::new(Scope::default());
    let permit = acquire(Arc::clone(&scope)).await.unwrap();
    let managed = permit
        .start_manager(db, GenerationCandidate::default())
        .await
        .unwrap();
    let retained_generations = managed.generations();
    drop(managed);
    let mut successor = Box::pin(acquire(Arc::clone(&scope)));
    assert!(futures::poll!(successor.as_mut()).is_pending());
    drop(retained_generations);
    drop(successor.await.unwrap());
}

#[tokio::test]
async fn aborted_worker_after_real_sqlite_commit_poison_fences_reconstruction() {
    let file = tempfile::NamedTempFile::new().unwrap();
    let url = format!("sqlite:{}", file.path().display());
    let db = Db::connect_sqlite(&url).await.unwrap();
    let document = br#"{"owner":"host-tls","actor":"operator","change_ref":"change-1","names":[]}"#;
    initialize(&db, document, true).await.unwrap();

    let scope = Arc::new(Scope::default());
    let first = acquire(Arc::clone(&scope)).await.unwrap();
    let worker_db = db.clone();
    let (committed_tx, committed_rx) = tokio::sync::oneshot::channel();
    let parked = Arc::new(tokio::sync::Semaphore::new(0));
    let worker_parked = Arc::clone(&parked);
    let worker = tokio::spawn(tracked_write(first.hold(), async move {
        let names = BTreeSet::from([TrustProfileRef::new("b.test").unwrap()]);
        union(&worker_db, &names).await.unwrap();
        committed_tx.send(()).unwrap();
        let _permit = worker_parked.acquire().await.unwrap();
    }));
    committed_rx.await.unwrap();
    drop(first);
    let mut successor = Box::pin(acquire(Arc::clone(&scope)));
    assert!(futures::poll!(successor.as_mut()).is_pending());
    worker.abort();
    assert!(worker.await.unwrap_err().is_cancelled());
    assert!(matches!(successor.await, Err(HistoryError::Poisoned)));
    assert!(load(&db)
        .await
        .unwrap()
        .names()
        .contains(&TrustProfileRef::new("b.test").unwrap()));
}

#[tokio::test]
async fn dropping_returned_write_keeps_owner_until_real_sqlite_work_finishes() {
    let file = tempfile::NamedTempFile::new().unwrap();
    let url = format!("sqlite:{}", file.path().display());
    let db = Db::connect_sqlite(&url).await.unwrap();
    let document = br#"{"owner":"host-tls","actor":"operator","change_ref":"change-1","names":[]}"#;
    initialize(&db, document, true).await.unwrap();
    // Hold the SQLite write lock so the detached worker cannot finish until
    // the test has observed it and dropped its returned future.
    let mut lock = db.pool().acquire().await.unwrap();
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *lock)
        .await
        .unwrap();
    let scope = Arc::new(Scope::default());
    let first = acquire(Arc::clone(&scope)).await.unwrap();
    let history = first
        .start_manager(db.clone(), GenerationCandidate::default())
        .await
        .unwrap();
    let names = BTreeSet::from([TrustProfileRef::new("b.test").unwrap()]);
    let response = history.adapter.reserve(names).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while scope.started.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("SQLite worker started");
    drop(response);
    drop(history);
    let mut successor = Box::pin(acquire(Arc::clone(&scope)));
    assert!(futures::poll!(successor.as_mut()).is_pending());
    sqlx::query("COMMIT").execute(&mut *lock).await.unwrap();
    drop(lock);
    let _next = tokio::time::timeout(std::time::Duration::from_secs(5), successor)
        .await
        .expect("completed worker releases the owner")
        .unwrap();
    assert!(load(&db)
        .await
        .unwrap()
        .names()
        .contains(&TrustProfileRef::new("b.test").unwrap()));
}

#[tokio::test]
async fn saturated_detached_writes_refuse_new_work_before_spawning() {
    let file = tempfile::NamedTempFile::new().unwrap();
    let url = format!("sqlite:{}", file.path().display());
    let db = Db::connect_sqlite(&url).await.unwrap();
    let document = br#"{"owner":"host-tls","actor":"operator","change_ref":"change-1","names":[]}"#;
    initialize(&db, document, true).await.unwrap();
    let mut lock = db.pool().acquire().await.unwrap();
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *lock)
        .await
        .unwrap();
    let scope = Arc::new(Scope::default());
    let permit = acquire(Arc::clone(&scope)).await.unwrap();
    let managed = permit
        .start_manager(db.clone(), GenerationCandidate::default())
        .await
        .unwrap();
    let names = BTreeSet::from([TrustProfileRef::new("b.test").unwrap()]);
    let mut writes = Vec::new();
    for _ in 0..MAX_PENDING_WRITES {
        writes.push(managed.adapter.reserve(names.clone()).unwrap());
    }
    assert!(matches!(
        managed.adapter.reserve(names),
        Err(TransportError::SourceUnsupported)
    ));
    drop(writes);
    drop(managed);
    let mut successor = Box::pin(acquire(Arc::clone(&scope)));
    assert!(futures::poll!(successor.as_mut()).is_pending());
    sqlx::query("COMMIT").execute(&mut *lock).await.unwrap();
    drop(lock);
    let _next = tokio::time::timeout(std::time::Duration::from_secs(10), successor)
        .await
        .expect("detached workers eventually release the owner")
        .unwrap();
}

#[test]
fn runtime_shutdown_poison_fences_an_unresolved_worker() {
    let scope = Arc::new(Scope::default());
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let first = acquire(Arc::clone(&scope)).await.unwrap();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let worker = tokio::spawn(tracked_write(first.hold(), async move {
            started_tx.send(()).unwrap();
            std::future::pending::<()>().await;
        }));
        started_rx.await.unwrap();
        drop(worker);
        drop(first);
    });
    // Runtime shutdown aborts the detached task. Its guard must poison the
    // shared scope before another runtime can obtain the owner slot.
    drop(runtime);
    let next_runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    assert!(matches!(
        next_runtime.block_on(acquire(scope)),
        Err(HistoryError::Poisoned)
    ));
}
