use opensesame_storage::{host_membership::MembershipWithdrawal, sqlite_file_url, Db};

fn withdrawal<'a>(id: &'a str, revision: &'a str) -> MembershipWithdrawal<'a> {
    MembershipWithdrawal {
        withdrawal_id: id,
        organization_id: "org",
        principal_id: "principal",
        membership_incarnation: "incarnation",
        authority_revision: revision,
    }
}

#[tokio::test]
async fn withdrawal_is_idempotent_and_survives_reconnect() {
    let directory = tempfile::tempdir().unwrap();
    let url = sqlite_file_url(&directory.path().join("host.sqlite"));
    let db = Db::connect_sqlite(&url).await.unwrap();
    assert!(db
        .withdraw_host_membership(&withdrawal("withdrawal", "revision"))
        .await
        .unwrap());
    assert!(!db
        .withdraw_host_membership(&withdrawal("withdrawal", "revision"))
        .await
        .unwrap());
    drop(db);

    let restarted = Db::connect_sqlite(&url).await.unwrap();
    assert!(!restarted
        .host_membership_live("org", "principal", "incarnation", "revision")
        .await
        .unwrap());
    assert!(restarted
        .host_membership_live("org", "principal", "incarnation", "new-revision")
        .await
        .unwrap());
}

#[tokio::test]
async fn withdrawal_id_cannot_be_reused_for_different_authority() {
    let db = Db::connect_memory().await.unwrap();
    assert!(db
        .withdraw_host_membership(&withdrawal("withdrawal", "first"))
        .await
        .unwrap());
    assert!(db
        .withdraw_host_membership(&withdrawal("withdrawal", "second"))
        .await
        .is_err());
}
