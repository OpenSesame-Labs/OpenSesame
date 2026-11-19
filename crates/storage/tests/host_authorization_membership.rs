use opensesame_storage::{
    agent_capabilities::AgentLaunch,
    browser_pairing::{decide_browser_pairing_in_transaction, NewBrowserPairing},
    host_authorizations::HostAuthorization,
    host_membership::MembershipWithdrawal,
    Db,
};
use sqlx::Row;

async fn database() -> Db {
    let db = Db::connect_memory().await.unwrap();
    sqlx::query("INSERT INTO config_authorization_roles(organization_id,principal_id,role,revision,evidence_after) VALUES('org','person','owner',1,0)")
        .execute(db.pool()).await.unwrap();
    db
}

async fn challenge(db: &Db, client: &str) -> HostAuthorization {
    challenge_at_revision(db, client, None).await
}

async fn challenge_at_revision(
    db: &Db,
    client: &str,
    membership_revision: Option<(&str, &str)>,
) -> HostAuthorization {
    let device = format!("device-{client}");
    let code = format!("code-{client}");
    db.create_browser_pairing(&NewBrowserPairing {
        id: client,
        device_digest: &device,
        user_code_digest: &code,
        origin: "https://vault.example",
        dpop_jkt: "key",
        audience: "https://host.example",
        capabilities_json: "[\"host.sync.read\"]",
        now: 1000,
    })
    .await
    .unwrap();
    let mut tx = db.pool().begin().await.unwrap();
    assert!(decide_browser_pairing_in_transaction(
        &mut tx,
        &code,
        "person",
        "org",
        true,
        1000,
        membership_revision,
    )
    .await
    .unwrap()
    .is_some());
    tx.commit().await.unwrap();
    db.consume_browser_pairing(
        &device,
        "https://vault.example",
        "key",
        &format!("token-{client}"),
        1001,
    )
    .await
    .unwrap()
    .unwrap();
    let pending = HostAuthorization {
        id: format!("challenge-{client}"),
        client_id: client.into(),
        digest: format!("digest-{client}"),
        operation: "browser.authenticate".into(),
        target_id: client.into(),
        transition: None,
        run_version: None,
        expires_at: 1200,
    };
    assert!(db.create_host_authorization(&pending, 1002).await.unwrap());
    pending
}

async fn policy(db: &Db) -> (String, i64, i64, i64) {
    let row = sqlx::query("SELECT role,revision,evidence_after,(SELECT COUNT(*) FROM outbox_events WHERE event_type='config.authorization.identity_narrowed') AS events FROM config_authorization_roles WHERE organization_id='org' AND principal_id='person'")
        .fetch_one(db.pool()).await.unwrap();
    (
        row.get("role"),
        row.get("revision"),
        row.get("evidence_after"),
        row.get("events"),
    )
}

const MEMBER: &str = r#"{"role":"member","auth_time":1000}"#;
const INCARNATION: &str = "11111111-1111-4111-8111-111111111111";
const REVISION: &str = "22222222-2222-4222-8222-222222222222";
const NEXT_REVISION: &str = "33333333-3333-4333-8333-333333333333";

fn versioned_member() -> String {
    format!(
        r#"{{"role":"member","auth_time":1000,"membership_incarnation":"{INCARNATION}","authority_revision":"{REVISION}"}}"#
    )
}

fn evidence_for(revision: &str) -> String {
    format!(
        r#"{{"role":"member","auth_time":1000,"membership_incarnation":"{INCARNATION}","authority_revision":"{revision}"}}"#
    )
}

fn launch<'a>(handle: &'a str, client: &'a str, now: i64) -> AgentLaunch<'a> {
    AgentLaunch {
        handle_digest: handle,
        principal_id: "person",
        organization_id: "org",
        client_id: client,
        audience: "audience",
        resource: "resource",
        capabilities_json: "[]",
        now,
    }
}

#[tokio::test]
async fn browser_authentication_atomically_binds_a_live_membership_revision() {
    let db = database().await;
    let pending = challenge(&db, "bound").await;
    let evidence = versioned_member();
    assert!(db
        .authorize_host_challenge(&pending, "bound-jti", Some(&evidence), None, 1003,)
        .await
        .unwrap());
    let row = sqlx::query(
        "SELECT membership_incarnation,authority_revision FROM browser_clients WHERE id='bound'",
    )
    .fetch_one(db.pool())
    .await
    .unwrap();
    assert_eq!(row.get::<String, _>("membership_incarnation"), INCARNATION);
    assert_eq!(row.get::<String, _>("authority_revision"), REVISION);
}

#[tokio::test]
async fn withdrawn_revision_refuses_binding_without_consuming_the_challenge() {
    let db = database().await;
    let pending = challenge(&db, "withdrawn").await;
    let evidence = versioned_member();
    sqlx::query("INSERT INTO host_membership_withdrawals(withdrawal_id,organization_id,principal_id,membership_incarnation,authority_revision) VALUES('withdrawal','org','person',?,?)")
        .bind(INCARNATION)
        .bind(REVISION)
        .execute(db.pool())
        .await
        .unwrap();
    assert!(!db
        .authorize_host_challenge(&pending, "withdrawn-jti", Some(&evidence), None, 1003,)
        .await
        .unwrap());
    assert!(db
        .host_authorization(&pending.id, "withdrawn", 1004)
        .await
        .unwrap()
        .is_some());
    let authentication: Option<String> =
        sqlx::query_scalar("SELECT authentication_json FROM browser_clients WHERE id='withdrawn'")
            .fetch_one(db.pool())
            .await
            .unwrap();
    assert!(authentication.is_none());
}

#[tokio::test]
async fn reauthentication_activates_rejoined_authority_for_agent_launches() {
    let db = database().await;
    let first = challenge(&db, "first-member").await;
    let first_evidence = versioned_member();
    assert!(db
        .authorize_host_challenge(
            &first,
            "first-member-jti",
            Some(&first_evidence),
            None,
            1003,
        )
        .await
        .unwrap());
    assert!(db
        .create_agent_launch(&launch("old-launch", "first-member", 1004))
        .await
        .unwrap());
    assert!(db
        .withdraw_host_membership(&MembershipWithdrawal {
            withdrawal_id: "old-withdrawal",
            organization_id: "org",
            principal_id: "person",
            membership_incarnation: INCARNATION,
            authority_revision: REVISION,
        })
        .await
        .unwrap());

    let rejoined =
        challenge_at_revision(&db, "rejoined-member", Some((INCARNATION, NEXT_REVISION))).await;
    let rejoined_evidence = evidence_for(NEXT_REVISION);
    assert!(db
        .authorize_host_challenge(
            &rejoined,
            "rejoined-member-jti",
            Some(&rejoined_evidence),
            None,
            1005,
        )
        .await
        .unwrap());
    assert!(db
        .create_agent_launch(&launch("new-launch", "rejoined-member", 1006))
        .await
        .unwrap());

    let rows: Vec<(String, i64, Option<String>)> = sqlx::query_as(
        "SELECT handle_digest,revoked,authority_revision FROM agent_launches ORDER BY handle_digest",
    )
    .fetch_all(db.pool())
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![
            ("new-launch".into(), 0, Some(NEXT_REVISION.into())),
            ("old-launch".into(), 1, Some(REVISION.into())),
        ]
    );
}

#[tokio::test]
async fn failed_client_update_rolls_back_claim_role_fence_and_outbox_then_retries() {
    let db = database().await;
    let pending = challenge(&db, "first").await;
    sqlx::query("CREATE TRIGGER fail_authentication BEFORE UPDATE OF authentication_json ON browser_clients BEGIN SELECT RAISE(ABORT,'injected storage failure'); END")
        .execute(db.pool()).await.unwrap();
    assert!(db
        .authorize_host_challenge(&pending, "jti", Some(MEMBER), None, 1003)
        .await
        .is_err());
    assert_eq!(policy(&db).await, ("owner".into(), 1, 0, 0));
    assert!(db
        .host_authorization(&pending.id, "first", 1004)
        .await
        .unwrap()
        .is_some());
    let authentication: Option<String> =
        sqlx::query_scalar("SELECT authentication_json FROM browser_clients WHERE id='first'")
            .fetch_one(db.pool())
            .await
            .unwrap();
    assert!(authentication.is_none());
    sqlx::query("DROP TRIGGER fail_authentication")
        .execute(db.pool())
        .await
        .unwrap();
    assert!(db
        .authorize_host_challenge(&pending, "jti", Some(MEMBER), None, 1004)
        .await
        .unwrap());
    assert_eq!(policy(&db).await, ("member".into(), 2, 0, 1));
}

#[tokio::test]
async fn duplicate_evidence_jti_has_no_second_policy_or_authentication_effect() {
    let db = database().await;
    let first = challenge(&db, "first").await;
    let second = challenge(&db, "second").await;
    assert!(db
        .authorize_host_challenge(&first, "same-jti", Some(MEMBER), None, 1003)
        .await
        .unwrap());
    let before = policy(&db).await;
    let result = db
        .authorize_host_challenge(&second, "same-jti", Some(MEMBER), None, 1004)
        .await;
    assert!(!result.unwrap_or(false));
    assert_eq!(policy(&db).await, before);
    assert!(db
        .host_authorization(&second.id, "second", 1005)
        .await
        .unwrap()
        .is_some());
    let authentication: Option<String> =
        sqlx::query_scalar("SELECT authentication_json FROM browser_clients WHERE id='second'")
            .fetch_one(db.pool())
            .await
            .unwrap();
    assert!(authentication.is_none());
}

#[tokio::test]
async fn distinct_bound_clients_can_use_the_same_authentication_time() {
    let db = database().await;
    let first = challenge(&db, "first").await;
    let second = challenge(&db, "second").await;
    assert!(db
        .authorize_host_challenge(&first, "first-jti", Some(MEMBER), None, 1003)
        .await
        .unwrap());
    assert!(db
        .authorize_host_challenge(&second, "second-jti", Some(MEMBER), None, 1004)
        .await
        .unwrap());
    assert_eq!(policy(&db).await, ("member".into(), 3, 0, 2));
    let authenticated: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM browser_clients WHERE authentication_json IS NOT NULL",
    )
    .fetch_one(db.pool())
    .await
    .unwrap();
    assert_eq!(authenticated, 2);
}

#[tokio::test]
async fn native_revocation_fence_refuses_equal_or_older_authentication_without_effect() {
    let db = database().await;
    let first = challenge(&db, "first").await;
    sqlx::query("UPDATE config_authorization_roles SET evidence_after=1000")
        .execute(db.pool())
        .await
        .unwrap();
    for auth_time in [999, 1000] {
        let evidence = format!(r#"{{"role":"member","auth_time":{auth_time}}}"#);
        assert!(db
            .authorize_host_challenge(&first, "jti", Some(&evidence), None, 1003)
            .await
            .is_err());
        assert_eq!(policy(&db).await, ("owner".into(), 1, 1000, 0));
    }
    assert!(db
        .authorize_host_challenge(
            &first,
            "jti",
            Some(r#"{"role":"member","auth_time":1001}"#),
            None,
            1004
        )
        .await
        .unwrap());
    assert_eq!(policy(&db).await, ("member".into(), 2, 1000, 1));
}
