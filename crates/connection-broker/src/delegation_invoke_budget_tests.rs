use super::InvokeBudgetClaim;
use crate::{BrokerConfig, ConnectionBroker};
use opensesame_storage::Db;

async fn seed_delegation(db: &Db) {
    sqlx::query("INSERT INTO connection_delegation_offers (id, organization_id, owner_subject, claim_token_hash, user_code_hash, manifest_digest, state, expires_at, created_at) VALUES ('offer', 'org', 'owner', 'claim', 'code', 'manifest', 'claimed', '9999', '2020')")
        .execute(db.pool()).await.unwrap();
    sqlx::query("INSERT INTO connection_delegation_offer_items (id, offer_id, connection_id, proposed_grant, state) VALUES ('item', 'offer', 'connection', '{}', 'accepted')")
        .execute(db.pool()).await.unwrap();
    sqlx::query("INSERT INTO connection_delegations (id, offer_id, offer_item_id, connection_id, organization_id, owner_subject, claimant_subject, grant_id, parent_grant_id, delegation_depth, budget_remaining, expires_at, created_at) VALUES ('delegation', 'offer', 'item', 'connection', 'org', 'owner', 'claimant', 'grant', 'parent', 1, '{\"invocations\":1}', '9999', '2020')")
        .execute(db.pool()).await.unwrap();
}

fn broker(db: &Db) -> ConnectionBroker {
    ConnectionBroker::new(
        db.pool().clone(),
        BrokerConfig::in_memory(Some([42; 32]), "http://127.0.0.1:8787"),
    )
    .unwrap()
}

async fn remaining(db: &Db) -> String {
    sqlx::query_scalar(
        "SELECT budget_remaining FROM connection_delegations WHERE id = 'delegation'",
    )
    .fetch_one(db.pool())
    .await
    .unwrap()
}

#[tokio::test]
async fn claim_survives_reopen_and_refuses_a_conflicting_binding() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite:{}?mode=rwc",
        directory.path().join("budget.db").display()
    );
    let db = Db::connect_sqlite(&url).await.unwrap();
    seed_delegation(&db).await;
    let first = broker(&db);
    let claim = first
        .claim_invoke_budget("org", "retry", "fingerprint-a", Some("delegation"))
        .await
        .unwrap();
    assert!(matches!(claim, InvokeBudgetClaim::Reserved { .. }));
    assert_eq!(remaining(&db).await, "{\"invocations\":0}");
    drop(first);
    db.pool().close().await;
    drop(db);

    let reopened = Db::connect_sqlite(&url).await.unwrap();
    let restarted = broker(&reopened);
    assert_eq!(
        restarted
            .claim_invoke_budget("org", "retry", "fingerprint-a", Some("delegation"))
            .await
            .unwrap(),
        InvokeBudgetClaim::Duplicate
    );
    assert_eq!(
        restarted
            .claim_invoke_budget("org", "retry", "fingerprint-b", Some("delegation"))
            .await
            .unwrap(),
        InvokeBudgetClaim::Conflict
    );
    assert!(restarted
        .claim_invoke_budget("org", "another", "fingerprint-a", Some("delegation"))
        .await
        .is_err());
    assert_eq!(remaining(&reopened).await, "{\"invocations\":0}");
}

#[tokio::test]
async fn concurrent_exact_claims_spend_once_and_only_owner_can_refund() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite:{}?mode=rwc",
        directory.path().join("concurrent.db").display()
    );
    // File-backed Db uses a multi-connection pool; race real SQLite writers.
    let db = Db::connect_sqlite(&url).await.unwrap();
    seed_delegation(&db).await;
    let first = broker(&db);
    let second = broker(&db);
    let (one, two) = tokio::join!(
        first.claim_invoke_budget("org", "key", "binding", Some("delegation")),
        second.claim_invoke_budget("org", "key", "binding", Some("delegation")),
    );
    let outcomes = [one.unwrap(), two.unwrap()];
    let claim_id = outcomes
        .iter()
        .find_map(|outcome| match outcome {
            InvokeBudgetClaim::Reserved { claim_id } => Some(claim_id.clone()),
            _ => None,
        })
        .expect("one owner");
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| **outcome == InvokeBudgetClaim::Duplicate)
            .count(),
        1
    );
    assert_eq!(remaining(&db).await, "{\"invocations\":0}");
    second
        .release_invoke_budget_claim("org", "not-the-claim")
        .await
        .unwrap();
    assert_eq!(remaining(&db).await, "{\"invocations\":0}");
    first
        .release_invoke_budget_claim("org", &claim_id)
        .await
        .unwrap();
    second
        .release_invoke_budget_claim("org", &claim_id)
        .await
        .unwrap();
    assert_eq!(remaining(&db).await, "{\"invocations\":1}");
}
