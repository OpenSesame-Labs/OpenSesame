use opensesame_storage::{
    agent_capabilities::AgentLaunch, browser_pairing::NewBrowserPairing,
    host_authorizations::HostAuthorization, host_membership::MembershipWithdrawal, Db,
};

const ORG: &str = "org";
const PERSON: &str = "person";
const INCARNATION: &str = "membership-a";
const OLD: &str = "revision-a";
const NEW: &str = "revision-b";

fn withdrawal<'a>(id: &'a str, revision: &'a str) -> MembershipWithdrawal<'a> {
    MembershipWithdrawal {
        withdrawal_id: id,
        organization_id: ORG,
        principal_id: PERSON,
        membership_incarnation: INCARNATION,
        authority_revision: revision,
    }
}

async fn database() -> Db {
    let db = Db::connect_memory().await.unwrap();
    sqlx::query("INSERT INTO config_authorization_roles(organization_id,principal_id,role,revision,evidence_after) VALUES('org','person','owner',1,0)")
        .execute(db.pool()).await.unwrap();
    db
}

async fn pair(db: &Db, id: &str) -> HostAuthorization {
    let code = format!("code-{id}");
    let device = format!("device-{id}");
    assert!(db
        .create_browser_pairing(&NewBrowserPairing {
            id,
            device_digest: &device,
            user_code_digest: &code,
            origin: "https://vault.example",
            dpop_jkt: "key",
            audience: "https://host.example",
            capabilities_json: "[\"host.sync.read\"]",
            now: 1000,
        })
        .await
        .unwrap());
    assert!(db
        .decide_browser_pairing(&code, PERSON, ORG, true, 1000)
        .await
        .unwrap());
    db.consume_browser_pairing(
        &device,
        "https://vault.example",
        "key",
        &format!("token-{id}"),
        1001,
    )
    .await
    .unwrap()
    .unwrap();
    let challenge = HostAuthorization {
        id: format!("challenge-{id}"),
        client_id: id.into(),
        digest: format!("digest-{id}"),
        operation: "browser.authenticate".into(),
        target_id: id.into(),
        transition: None,
        run_version: None,
        expires_at: 1200,
    };
    assert!(db
        .create_host_authorization(&challenge, 1002)
        .await
        .unwrap());
    challenge
}

fn assertion(revision: &str) -> String {
    serde_json::json!({"role":"member", "auth_time":1000,
        "membership_incarnation":INCARNATION,"authority_revision":revision})
    .to_string()
}

fn launch<'a>(handle: &'a str) -> AgentLaunch<'a> {
    AgentLaunch {
        handle_digest: handle,
        principal_id: PERSON,
        organization_id: ORG,
        client_id: "client",
        audience: "audience",
        resource: "host",
        capabilities_json: "[\"host.sync.write\"]",
        now: 1000,
    }
}

#[tokio::test]
async fn withdrawal_blocks_old_evidence_and_preserves_a_new_revision_on_retry() {
    let db = database().await;
    let old = pair(&db, "old").await;
    assert!(db
        .authorize_host_challenge(&old, "jti-old", Some(&assertion(OLD)), None, 1003)
        .await
        .unwrap());
    let _legacy = pair(&db, "legacy").await;
    assert!(db.create_agent_launch(&launch("old-agent")).await.unwrap());
    assert!(db
        .withdraw_host_membership(&withdrawal("withdrawal-1", OLD), 1004)
        .await
        .unwrap());
    assert!(!db
        .host_membership_live(ORG, PERSON, Some((INCARNATION, OLD)))
        .await
        .unwrap());
    assert!(!db
        .activate_host_membership(ORG, PERSON, INCARNATION, OLD)
        .await
        .unwrap());
    assert!(db.browser_grant("token-old", 1005).await.unwrap().is_none());
    assert!(db
        .browser_grant("token-legacy", 1005)
        .await
        .unwrap()
        .is_none());
    assert!(db
        .host_authorization("challenge-legacy", "legacy", 1005)
        .await
        .unwrap()
        .is_none());
    assert!(db
        .exchange_agent_launch(
            "old-agent",
            "agent-token",
            "client",
            "audience",
            "host",
            1005
        )
        .await
        .unwrap()
        .is_none());
    assert!(!db
        .create_agent_launch(&launch("untagged-agent"))
        .await
        .unwrap());

    let fresh = pair(&db, "fresh").await;
    assert!(
        db.browser_grant("token-fresh", 1005)
            .await
            .unwrap()
            .unwrap()
            .identity_required
    );
    assert!(!db
        .authorize_host_challenge(&fresh, "jti-stale", Some(&assertion(OLD)), None, 1005)
        .await
        .unwrap());
    assert!(!db
        .authorize_host_challenge(
            &fresh,
            "jti-legacy",
            Some(r#"{"role":"member","auth_time":1000}"#),
            None,
            1005
        )
        .await
        .unwrap());
    assert!(db
        .authorize_host_challenge(&fresh, "jti-new", Some(&assertion(NEW)), None, 1005)
        .await
        .unwrap());
    assert!(!db
        .create_agent_launch_bound(&launch("old-revision"), Some((INCARNATION, OLD)))
        .await
        .unwrap());
    assert!(db
        .create_agent_launch_bound(&launch("new-revision"), Some((INCARNATION, NEW)))
        .await
        .unwrap());
    assert!(!db
        .withdraw_host_membership(&withdrawal("withdrawal-1", OLD), 1006)
        .await
        .unwrap());
    let current = db
        .browser_grant("token-fresh", 1006)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.authority_revision.as_deref(), Some(NEW));
    assert!(db
        .exchange_agent_launch(
            "new-revision",
            "new-token",
            "client",
            "audience",
            "host",
            1006
        )
        .await
        .unwrap()
        .is_some());
    assert!(db
        .withdraw_host_membership(&withdrawal("withdrawal-1", NEW), 1007)
        .await
        .is_err());
}

#[tokio::test]
async fn failed_browser_revocation_rolls_back_the_tombstone() {
    let db = database().await;
    let _legacy = pair(&db, "legacy").await;
    sqlx::query("CREATE TRIGGER fail_withdraw BEFORE UPDATE OF revoked_at ON browser_clients BEGIN SELECT RAISE(ABORT,'injected'); END")
        .execute(db.pool()).await.unwrap();
    assert!(db
        .withdraw_host_membership(&withdrawal("withdrawal-1", OLD), 1004)
        .await
        .is_err());
    assert!(db
        .host_membership_live(ORG, PERSON, Some((INCARNATION, OLD)))
        .await
        .unwrap());
    assert!(db
        .browser_grant("token-legacy", 1005)
        .await
        .unwrap()
        .is_some());
    sqlx::query("DROP TRIGGER fail_withdraw")
        .execute(db.pool())
        .await
        .unwrap();
    assert!(db
        .withdraw_host_membership(&withdrawal("withdrawal-1", OLD), 1005)
        .await
        .unwrap());
    assert!(db
        .browser_grant("token-legacy", 1006)
        .await
        .unwrap()
        .is_none());
}
