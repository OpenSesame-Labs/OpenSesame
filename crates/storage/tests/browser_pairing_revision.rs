use opensesame_storage::{
    browser_pairing::NewBrowserPairing, host_authorizations::HostAuthorization,
    host_membership::MembershipWithdrawal, Db,
};

const ORG: &str = "org";
const PRINCIPAL: &str = "person";
const INC: &str = "incarnation";
const OLD: &str = "old-revision";
const NEW: &str = "new-revision";

async fn approve(db: &Db, id: &str) {
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
    assert!(db
        .decide_browser_pairing(&format!("code-{id}"), PRINCIPAL, ORG, true, 1001)
        .await
        .unwrap());
}

async fn withdraw(db: &Db, id: &str, revision: &str) {
    assert!(db
        .withdraw_host_membership(
            &MembershipWithdrawal {
                withdrawal_id: id,
                organization_id: ORG,
                principal_id: PRINCIPAL,
                membership_incarnation: INC,
                authority_revision: revision,
            },
            1002
        )
        .await
        .unwrap());
}

#[tokio::test]
async fn a_delayed_withdrawal_does_not_cancel_a_pairing_bound_to_a_new_revision() {
    let db = Db::connect_memory().await.unwrap();
    assert!(db
        .activate_host_membership(ORG, PRINCIPAL, INC, OLD)
        .await
        .unwrap());
    approve(&db, "old").await;
    assert!(db
        .activate_host_membership(ORG, PRINCIPAL, INC, NEW)
        .await
        .unwrap());
    approve(&db, "new").await;
    withdraw(&db, "withdraw-old", OLD).await;
    assert!(db
        .consume_browser_pairing(
            "device-old",
            "https://vault.example",
            "key",
            "token-old",
            1003
        )
        .await
        .unwrap()
        .is_none());
    let fresh = db
        .consume_browser_pairing(
            "device-new",
            "https://vault.example",
            "key",
            "token-new",
            1003,
        )
        .await
        .unwrap()
        .unwrap();
    assert!(fresh.identity_required);
    assert_eq!(fresh.membership_incarnation.as_deref(), Some(INC));
    assert_eq!(fresh.authority_revision.as_deref(), Some(NEW));
    sqlx::query("INSERT INTO config_authorization_roles(organization_id,principal_id,role,revision,evidence_after) VALUES('org','person','member',1,0)")
        .execute(db.pool()).await.unwrap();
    let challenge = HostAuthorization {
        id: "challenge".into(), client_id: "new".into(), digest: "digest".into(),
        operation: "browser.authenticate".into(), target_id: "new".into(),
        transition: None, run_version: None, expires_at: 1200,
    };
    assert!(db.create_host_authorization(&challenge, 1003).await.unwrap());
    let evidence = |revision| serde_json::json!({
        "role":"member", "auth_time":1000,
        "membership_incarnation":INC, "authority_revision":revision,
    }).to_string();
    assert!(!db.authorize_host_challenge(&challenge, "jti-old", Some(&evidence(OLD)), None, 1004).await.unwrap());
    assert!(db.authorize_host_challenge(&challenge, "jti-new", Some(&evidence(NEW)), None, 1004).await.unwrap());
    withdraw(&db, "withdraw-new", NEW).await;
    assert!(db.browser_grant("token-new", 1004).await.unwrap().is_none());
}

#[tokio::test]
async fn an_unbound_legacy_pairing_is_denied_on_the_first_withdrawal() {
    let db = Db::connect_memory().await.unwrap();
    approve(&db, "legacy").await;
    withdraw(&db, "withdraw-old", OLD).await;
    assert!(db
        .consume_browser_pairing(
            "device-legacy",
            "https://vault.example",
            "key",
            "token",
            1003
        )
        .await
        .unwrap()
        .is_none());
}
