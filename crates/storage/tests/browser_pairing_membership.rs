use opensesame_storage::{
    browser_pairing::{decide_browser_pairing_in_transaction, NewBrowserPairing},
    host_membership::MembershipWithdrawal,
    Db,
};

const ORG: &str = "6d034ab5-98ea-4bab-8215-5f135d35d78e";
const PRINCIPAL: &str = "principal:person:pairing-test";
const INCARNATION: &str = "2e2e9079-cf5a-44f9-8a7c-18c163452eeb";
const OLD_REVISION: &str = "2a96aed6-4b0a-48f5-b979-2140fa7281d7";
const NEW_REVISION: &str = "bb0810c7-2abe-4c6a-b265-2e70e62a7752";

async fn approve(db: &Db, id: &str, revision: Option<&str>) {
    assert!(db
        .create_browser_pairing(&NewBrowserPairing {
            id,
            device_digest: &format!("device-{id}"),
            user_code_digest: &format!("code-{id}"),
            origin: "https://vault.example",
            dpop_jkt: "key",
            audience: "https://host.example",
            capabilities_json: "[\"host.sync.read\"]",
            now: 1000,
        })
        .await
        .unwrap());
    let mut tx = db.pool().begin().await.unwrap();
    let membership = revision.map(|revision| (INCARNATION, revision));
    assert!(decide_browser_pairing_in_transaction(
        &mut tx,
        &format!("code-{id}"),
        PRINCIPAL,
        ORG,
        true,
        1001,
        membership,
    )
    .await
    .unwrap()
    .is_some());
    tx.commit().await.unwrap();
}

async fn withdraw(db: &Db, id: &str, revision: &str) {
    assert!(db
        .withdraw_host_membership(&MembershipWithdrawal {
            withdrawal_id: id,
            organization_id: ORG,
            principal_id: PRINCIPAL,
            membership_incarnation: INCARNATION,
            authority_revision: revision,
        })
        .await
        .unwrap());
}

#[tokio::test]
async fn pairing_authority_is_fenced_by_exact_membership_revision() {
    let db = Db::connect_memory().await.unwrap();
    approve(&db, "old", Some(OLD_REVISION)).await;
    withdraw(&db, "withdraw-old", OLD_REVISION).await;
    assert!(db
        .consume_browser_pairing(
            "device-old",
            "https://vault.example",
            "key",
            "token-old",
            1002,
        )
        .await
        .unwrap()
        .is_none());

    approve(&db, "new", Some(NEW_REVISION)).await;
    let grant = db
        .consume_browser_pairing(
            "device-new",
            "https://vault.example",
            "key",
            "token-new",
            1002,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(grant.membership_incarnation.as_deref(), Some(INCARNATION));
    assert_eq!(grant.authority_revision.as_deref(), Some(NEW_REVISION));
    assert!(db.browser_grant("token-new", 1003).await.unwrap().is_some());
    withdraw(&db, "withdraw-new", NEW_REVISION).await;
    assert!(db.browser_grant("token-new", 1003).await.unwrap().is_none());
    assert!(db
        .renew_browser_grant(
            "token-new",
            "token-renewed",
            "[\"host.sync.read\"]",
            1800,
            1003,
        )
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn unbound_legacy_pairing_fails_closed_after_any_withdrawal() {
    let db = Db::connect_memory().await.unwrap();
    approve(&db, "legacy", None).await;
    withdraw(&db, "withdraw-old", OLD_REVISION).await;
    assert!(db
        .consume_browser_pairing(
            "device-legacy",
            "https://vault.example",
            "key",
            "token-legacy",
            1002,
        )
        .await
        .unwrap()
        .is_none());
}
