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

const STORED_MODES: [(&str, &str); 7] = [
    ("StoredMode.relay", "relay"),
    ("StoredMode.broker", "broker"),
    ("StoredMode.upper", "Relay"),
    ("StoredMode.shout", "BROKER"),
    ("StoredMode.padded", " relay"),
    ("StoredMode.empty", ""),
    ("StoredMode.unknown", "unknown"),
];

fn mode_name(mode: Option<ExecutionMode>) -> &'static str {
    match mode {
        None => "none",
        Some(ExecutionMode::Relay) => "some (Mode.relay)",
        Some(ExecutionMode::Broker) => "some (Mode.broker)",
    }
}

async fn delegation_count(db: &Db) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM connection_delegations")
        .fetch_one(db.pool())
        .await
        .unwrap()
}

/// Claim a relay offer whose stored item mode was rewritten to `raw`.
async fn claim_rewritten_offer(raw: &str) -> String {
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
    sqlx::query("UPDATE connection_delegation_offer_items SET execution_mode = ? WHERE id = ?")
        .bind(raw)
        .bind(&item_id)
        .execute(db.pool())
        .await
        .unwrap();
    let claim = ClaimOfferRequest {
        claim_token: minted.claim_token,
        user_code: minted.user_code,
        accepted_item_ids: vec![item_id],
    };
    let outcome = match broker.claim_delegation_offer(claim, GUEST, PEPPER).await {
        Ok(claimed) if claimed.len() == 1 => "ok",
        Err(error) if error.code() == "delegation_unavailable" => "unavailable",
        Err(_) => "invalid",
        Ok(_) => "partial",
    };
    let count = delegation_count(&db).await;
    if (outcome == "ok") == (count == 1) {
        outcome.to_owned()
    } else {
        format!("{outcome}:{count} delegations")
    }
}

/// Resolve a claimed relay delegation whose stored mode was rewritten to `raw`.
async fn resolve_rewritten_delegation(raw: &str) -> &'static str {
    let (db, broker, org, connection) = fixture().await;
    let minted = broker
        .mint_delegation_offer(&org, OWNER, relay_offer(&connection), PEPPER)
        .await
        .unwrap();
    let manifest = broker
        .present_delegation_offer(&minted.claim_token)
        .await
        .unwrap();
    let claim = ClaimOfferRequest {
        claim_token: minted.claim_token,
        user_code: minted.user_code,
        accepted_item_ids: vec![manifest.items[0].id.clone()],
    };
    let delegation = broker
        .claim_delegation_offer(claim, GUEST, PEPPER)
        .await
        .unwrap()
        .remove(0);
    sqlx::query("UPDATE connection_delegations SET execution_mode = ? WHERE id = ?")
        .bind(raw)
        .bind(&delegation.id)
        .execute(db.pool())
        .await
        .unwrap();
    let live = broker
        .find_live_delegation_by_id(GUEST, &delegation.id)
        .await
        .unwrap();
    mode_name(live.map(|live| live.execution_mode))
}

/// Minting is refused exactly when claiming that parsed mode is.
async fn mint_outcome(mode: ExecutionMode) -> &'static str {
    let (_db, broker, org, connection) = fixture().await;
    let mut request = relay_offer(&connection);
    request.items[0].execution_mode = mode;
    match broker
        .mint_delegation_offer(&org, OWNER, request, PEPPER)
        .await
    {
        Ok(_) => "ok",
        Err(error) if error.code() == "delegation_unavailable" => "unavailable",
        Err(_) => "invalid",
    }
}

#[tokio::test]
#[ignore = "requires Lean vectors; run spec/formal/host-cli/verify.sh"]
async fn lean_mode_vectors_match_parse_claim_and_resolution() {
    let path = std::env::var("OPENSESAME_HOST_CLI_VECTORS").expect("run the host-cli verifier");
    let text = std::fs::read_to_string(path).expect("read formal vectors");
    let cases: Vec<Vec<&str>> = text
        .lines()
        .map(|line| line.split('\t').collect::<Vec<_>>())
        .filter(|fields| fields[0] == "mode")
        .collect();
    for f in &cases {
        let raw = STORED_MODES
            .iter()
            .find(|(m, _)| *m == f[1])
            .expect("mode")
            .1;
        let parsed = crate::delegation::parse_execution_mode(raw).ok();
        let minted = match parsed {
            Some(mode) => mint_outcome(mode).await,
            None => "invalid",
        };
        let actual = format!(
            "{}\t{}\t{}\t{minted}",
            mode_name(parsed),
            claim_rewritten_offer(raw).await,
            resolve_rewritten_delegation(raw).await,
        );
        let expected = format!("{}\t{}\t{}\t{}", f[2], f[3], f[2], f[3]);
        assert_eq!(
            actual,
            expected,
            "decision mismatch for mode {}",
            f.join(" ")
        );
    }
    assert_eq!(cases.len(), 7, "incomplete mode vectors");
}
