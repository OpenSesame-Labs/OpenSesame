//! Malformed persisted modes must never become broker authority.
use super::*;
use crate::delegation::{ClaimOfferRequest, MintOfferRequest, OfferItemSpec};
use opensesame_domain::Shareability;
use opensesame_relay::ExecutionMode;

const OWNER: &str = "user:owner";
const GUEST: &str = "user:guest";
const PEPPER: &str = "test-pepper";

async fn fixture() -> (Db, ConnectionBroker, OrganizationId, String) {
    let config = key_config().with_detected_connection(
        "workos",
        BTreeMap::from([("api_key".into(), "test-only-workos-key".into())]),
    );
    let (db, broker) = broker_with(config).await;
    let org = OrganizationId::new();
    let connection = broker
        .create_connection(
            &org,
            CreateConnection {
                owner_subject: Some(OWNER.into()),
                shareability: Some(Shareability::Delegable),
                display_name: Some("WorkOS".into()),
                ..create("workos")
            },
        )
        .await
        .unwrap()
        .connection_id;
    (db, broker, org, connection)
}

fn relay_offer(connection: &str) -> MintOfferRequest {
    MintOfferRequest {
        items: vec![OfferItemSpec {
            connection_id: connection.into(),
            actions: None,
            resources: None,
            expires_in_seconds: None,
            budgets: None,
            execution_mode: ExecutionMode::Relay,
            required: true,
            dependencies: vec![],
        }],
        ttl_seconds: None,
    }
}

async fn corrupt_offer_mode(db: &Db, item_id: &str) {
    sqlx::query(
        "UPDATE connection_delegation_offer_items SET execution_mode = 'unknown' WHERE id = ?",
    )
    .bind(item_id)
    .execute(db.pool())
    .await
    .unwrap();
}

async fn assert_no_delegations(db: &Db) {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM connection_delegations")
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn malformed_mode_is_not_presented_as_a_broker_offer() {
    let (db, broker, org, connection) = fixture().await;
    let minted = broker
        .mint_delegation_offer(&org, OWNER, relay_offer(&connection), PEPPER)
        .await
        .unwrap();
    corrupt_offer_mode(&db, &minted.offer.items[0].id).await;
    assert!(broker
        .present_delegation_offer(&minted.claim_token)
        .await
        .is_err());
    assert_no_delegations(&db).await;
}

#[tokio::test]
async fn malformed_mode_after_presentation_cannot_be_claimed_as_broker() {
    let (db, broker, org, connection) = fixture().await;
    let minted = broker
        .mint_delegation_offer(&org, OWNER, relay_offer(&connection), PEPPER)
        .await
        .unwrap();
    let manifest = broker
        .present_delegation_offer(&minted.claim_token)
        .await
        .unwrap();
    let item_id = manifest.items[0].id.clone();
    corrupt_offer_mode(&db, &item_id).await;
    let result = broker
        .claim_delegation_offer(
            ClaimOfferRequest {
                claim_token: minted.claim_token,
                user_code: minted.user_code,
                accepted_item_ids: vec![item_id],
            },
            GUEST,
            PEPPER,
        )
        .await;
    assert!(result.is_err());
    assert_no_delegations(&db).await;
}

#[tokio::test]
async fn malformed_claimed_mode_cannot_be_listed_or_narrowed() {
    let (db, broker, org, connection) = fixture().await;
    let minted = broker
        .mint_delegation_offer(&org, OWNER, relay_offer(&connection), PEPPER)
        .await
        .unwrap();
    let manifest = broker
        .present_delegation_offer(&minted.claim_token)
        .await
        .unwrap();
    let claimed = broker
        .claim_delegation_offer(
            ClaimOfferRequest {
                claim_token: minted.claim_token,
                user_code: minted.user_code,
                accepted_item_ids: vec![manifest.items[0].id.clone()],
            },
            GUEST,
            PEPPER,
        )
        .await
        .unwrap();
    let delegation = &claimed[0];
    sqlx::query("UPDATE connection_delegations SET execution_mode = 'unknown' WHERE id = ?")
        .bind(&delegation.id)
        .execute(db.pool())
        .await
        .unwrap();
    assert!(broker.list_delegations_for(&org, GUEST).await.is_err());
    assert!(broker
        .narrow_delegation(&org, OWNER, &delegation.id, None, None, None)
        .await
        .is_err());
    let grant: String =
        sqlx::query_scalar("SELECT grant_id FROM connection_delegations WHERE id = ?")
            .bind(&delegation.id)
            .fetch_one(db.pool())
            .await
            .unwrap();
    assert_eq!(grant, delegation.grant_id);
    let revoked: Option<String> = sqlx::query_scalar("SELECT revoked_at FROM grants WHERE id = ?")
        .bind(&grant)
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert!(revoked.is_none());
}

#[tokio::test]
async fn new_broker_offer_is_refused_until_mode_is_authenticated() {
    let (db, broker, org, connection) = fixture().await;
    let mut request = relay_offer(&connection);
    request.items[0].execution_mode = ExecutionMode::Broker;
    let error = broker
        .mint_delegation_offer(&org, OWNER, request, PEPPER)
        .await
        .expect_err("broker offer refused");
    assert_eq!(error.code(), "delegation_unavailable");
    assert_eq!(error.http_status(), 503);
    let offers: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM connection_delegation_offers")
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(offers, 0);
}

#[tokio::test]
async fn relay_offer_rewritten_to_valid_broker_mode_cannot_be_claimed() {
    let (db, broker, org, connection) = fixture().await;
    let minted = broker
        .mint_delegation_offer(&org, OWNER, relay_offer(&connection), PEPPER)
        .await
        .unwrap();
    let manifest = broker
        .present_delegation_offer(&minted.claim_token)
        .await
        .unwrap();
    let item_id = manifest.items[0].id.clone();
    sqlx::query(
        "UPDATE connection_delegation_offer_items SET execution_mode = 'broker' WHERE id = ?",
    )
    .bind(&item_id)
    .execute(db.pool())
    .await
    .unwrap();
    // A database-stored digest is not an independent authentication boundary.
    sqlx::query(
        "UPDATE connection_delegation_offers SET manifest_digest = 'sha256:changed' WHERE id = ?",
    )
    .bind(&minted.offer.id)
    .execute(db.pool())
    .await
    .unwrap();
    let error = broker
        .claim_delegation_offer(
            ClaimOfferRequest {
                claim_token: minted.claim_token,
                user_code: minted.user_code,
                accepted_item_ids: vec![item_id],
            },
            GUEST,
            PEPPER,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), "delegation_unavailable");
    assert_no_delegations(&db).await;
}
