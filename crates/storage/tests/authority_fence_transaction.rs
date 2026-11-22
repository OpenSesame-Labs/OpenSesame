//! Composable fence writes remain provisional until their caller commits.

mod fence_support;

use fence_support::{db, seed_chain, status};
use opensesame_storage::authority_fence::fence_grant_on;
use opensesame_time::Utc;

#[tokio::test]
async fn multiple_fences_and_their_cascades_roll_back_together() {
    let db = db().await;
    let first = seed_chain(&db, 1).await;
    let second = seed_chain(&db, 1).await;
    let mut tx = db.pool().begin_with("BEGIN IMMEDIATE").await.unwrap();
    for root in [&first[0], &second[0]] {
        fence_grant_on(&mut tx, &root.id.to_string(), "test:retire", Utc::now())
            .await
            .unwrap();
    }
    let inside: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM grant_invalidations")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(inside, 2);
    tx.rollback().await.unwrap();
    assert!(status(&db, &first[1]).await.authorizes());
    assert!(status(&db, &second[1]).await.authorizes());
    assert_eq!(db.fence_high_water().await.unwrap(), 0);
}

#[tokio::test]
async fn multiple_fences_commit_together_and_remain_idempotent() {
    let db = db().await;
    let first = seed_chain(&db, 1).await;
    let second = seed_chain(&db, 1).await;
    let mut tx = db.pool().begin_with("BEGIN IMMEDIATE").await.unwrap();
    let first_commit = fence_grant_on(&mut tx, &first[0].id.to_string(), "test:retire", Utc::now())
        .await
        .unwrap();
    let second_commit = fence_grant_on(
        &mut tx,
        &second[0].id.to_string(),
        "test:retire",
        Utc::now(),
    )
    .await
    .unwrap();
    let retry = fence_grant_on(&mut tx, &first[0].id.to_string(), "test:retry", Utc::now())
        .await
        .unwrap();
    assert!(!retry.newly_fenced);
    assert_eq!(retry.sequence, first_commit.sequence);
    assert_ne!(first_commit.sequence, second_commit.sequence);
    tx.commit().await.unwrap();
    assert!(!status(&db, &first[1]).await.authorizes());
    assert!(!status(&db, &second[1]).await.authorizes());
}

#[tokio::test]
async fn a_missing_second_root_can_be_rolled_back_with_the_first() {
    let db = db().await;
    let chain = seed_chain(&db, 1).await;
    let mut tx = db.pool().begin_with("BEGIN IMMEDIATE").await.unwrap();
    fence_grant_on(&mut tx, &chain[0].id.to_string(), "test:retire", Utc::now())
        .await
        .unwrap();
    assert!(
        fence_grant_on(&mut tx, "grant:missing", "test:retire", Utc::now())
            .await
            .is_err()
    );
    tx.rollback().await.unwrap();
    assert!(status(&db, &chain[1]).await.authorizes());
}

#[tokio::test]
async fn an_existing_fence_does_not_commit_the_callers_transaction() {
    let db = db().await;
    let first = seed_chain(&db, 1).await;
    let second = seed_chain(&db, 1).await;
    let original = db
        .fence_grant(&first[0].id.to_string(), "test:first", Utc::now())
        .await
        .unwrap();
    let mut tx = db.pool().begin_with("BEGIN IMMEDIATE").await.unwrap();
    let existing = fence_grant_on(&mut tx, &first[0].id.to_string(), "test:retry", Utc::now())
        .await
        .unwrap();
    assert!(!existing.newly_fenced);
    assert_eq!(existing.sequence, original.sequence);
    fence_grant_on(&mut tx, &second[0].id.to_string(), "test:later", Utc::now())
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    assert!(!status(&db, &first[1]).await.authorizes());
    assert!(status(&db, &second[1]).await.authorizes());
    assert_eq!(db.fence_high_water().await.unwrap(), original.sequence);
}

#[tokio::test]
async fn a_plausible_path_for_a_different_grant_cannot_be_fenced() {
    let db = db().await;
    let chain = seed_chain(&db, 1).await;
    sqlx::query("UPDATE grant_lineage SET ancestor_path = ? WHERE grant_id = ?")
        .bind(format!("/{}/", chain[0].id))
        .bind(chain[1].id.to_string())
        .execute(db.pool())
        .await
        .unwrap();
    assert!(db
        .fence_grant(&chain[1].id.to_string(), "test:retire", Utc::now())
        .await
        .is_err());
    assert!(status(&db, &chain[0]).await.authorizes());
    assert_eq!(db.fence_high_water().await.unwrap(), 0);
}
