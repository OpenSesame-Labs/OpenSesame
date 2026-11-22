//! Independently started replicas serialize migrations on the shared store.
use opensesame_storage::{sqlite_file_url, Db};
use std::sync::Arc;

#[tokio::test]
async fn simultaneous_replica_startup_migrates_every_version_once() {
    let directory = tempfile::tempdir().unwrap();
    let url = sqlite_file_url(&directory.path().join("host.sqlite"));
    let barrier = Arc::new(tokio::sync::Barrier::new(4));
    let mut tasks = Vec::new();
    for _ in 0..4 {
        let url = url.clone();
        let barrier = Arc::clone(&barrier);
        tasks.push(tokio::spawn(async move {
            barrier.wait().await;
            Db::connect_sqlite(&url).await
        }));
    }
    let mut databases = Vec::new();
    for task in tasks {
        databases.push(task.await.unwrap().expect("replica migrates shared store"));
    }
    let expected = databases[0].applied_migrations().await.unwrap();
    assert_eq!(
        expected.len(),
        opensesame_storage::migration_versions().len()
    );
    for db in databases {
        assert_eq!(db.applied_migrations().await.unwrap(), expected);
    }
}
