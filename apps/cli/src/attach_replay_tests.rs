use super::*;

#[tokio::test]
async fn rejected_snapshot_sends_nothing_to_host_or_directory() {
    const CHILD: &str = "OPENSESAME_ATTACHMENT_REPLAY_TEST_CHILD";
    if std::env::var_os(CHILD).is_none() {
        // Set a valid synthetic credential in an isolated test process; do
        // not mutate the environment shared by other tests.
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "attach::tests::replay::rejected_snapshot_sends_nothing_to_host_or_directory",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .env(
                "OPENSESAME_OPERATOR_TOKEN",
                "synthetic-operator-token-0123456789",
            )
            .output()
            .unwrap();
        assert!(
            output.status.success() && String::from_utf8_lossy(&output.stdout).contains("1 passed"),
            "child failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }

    let store_dir = tempfile::tempdir().unwrap();
    let root = opensesame_sealed_store::init_store(store_dir.path(), &[]).unwrap();
    let key = opensesame_sealed_store::init_store_key(store_dir.path(), b"correct horse").unwrap();
    for (content, force) in [(b"old".as_slice(), false), (b"new".as_slice(), true)] {
        root.attach_add(
            "Taxes/2025",
            &mut std::io::Cursor::new(content),
            content.len() as u64,
            AttachMeta {
                filename: "taxes.pdf".into(),
                mime: None,
            },
            &key,
            force,
        )
        .unwrap();
        if !force {
            std::fs::copy(
                store_dir.path().join("Taxes/2025.osattach"),
                store_dir.path().join("old-manifest"),
            )
            .unwrap();
        }
    }
    std::fs::copy(
        store_dir.path().join("old-manifest"),
        store_dir.path().join("Taxes/2025.osattach"),
    )
    .unwrap();

    let (base, peer) = attachment_peer(vec![]).await;
    let error = cmd_attach_sync(None, &base, Some(store_dir.path()), None)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("revision does not match"));
    assert!(
        peer.await.unwrap().is_empty(),
        "no HTTP request may be sent"
    );

    let destination = tempfile::tempdir().unwrap();
    let prior = destination.path().join("attachments/Taxes/2025.osattach");
    std::fs::create_dir_all(prior.parent().unwrap()).unwrap();
    std::fs::write(&prior, b"existing replica").unwrap();
    assert!(cmd_attach_sync(
        Some(destination.path()),
        "http://unused",
        Some(store_dir.path()),
        None,
    )
    .await
    .is_err());
    assert_eq!(std::fs::read(prior).unwrap(), b"existing replica");
    assert!(!destination.path().join("attachments/.attachments").exists());
}
