use super::*;

#[test]
fn delayed_competing_creator_cannot_overwrite_the_winner() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey::generate();
    let (checked_tx, checked_rx) = std::sync::mpsc::sync_channel(0);
    let (completed_tx, completed_rx) = std::sync::mpsc::sync_channel(0);

    // Model creator B observing absence before creator A wins. B reaches its
    // locked write only after A has finished, which used to overwrite A.
    std::thread::scope(|scope| {
        let store = &root;
        let content_key = &key;
        let delayed = scope.spawn(move || {
            assert!(matches!(
                store.find_existing("a"),
                Err(StoreError::NotFound(_))
            ));
            checked_tx.send(()).unwrap();
            completed_rx.recv().unwrap();
            store.write_entry_with_optional_key(
                "a",
                &Entry::parse("second"),
                Some(content_key),
                None,
                true,
            )
        });
        checked_rx.recv().unwrap();
        root.insert("a", &Entry::parse("first"), &key).unwrap();
        completed_tx.send(()).unwrap();
        assert!(matches!(
            delayed.join().unwrap(),
            Err(StoreError::AlreadyExists(_))
        ));
    });
    assert_eq!(root.show("a", &key).unwrap().secret, "first");
    assert_eq!(root.revision("a").unwrap(), Some(1));
}

#[test]
fn removed_entry_replay_is_rejected_while_local_revision_state_is_intact() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey::generate();
    let entry = Entry::parse("old secret");
    root.insert("Dev/a", &entry, &key).unwrap();
    let path = dir.path().join("Dev/a.osseal");
    let old = fs::read(&path).unwrap();

    root.rm_with_key("Dev/a", &key).unwrap();
    assert_eq!(root.revisions().unwrap().get("Dev/a"), Some(&2));
    fs::write(&path, &old).unwrap();
    assert!(root.show("Dev/a", &key).is_err());

    fs::remove_file(&path).unwrap();
    root.insert("Dev/a", &Entry::parse("new secret"), &key)
        .unwrap();
    assert_eq!(root.revisions().unwrap().get("Dev/a"), Some(&3));
    assert_eq!(root.show("Dev/a", &key).unwrap().secret, "new secret");
    fs::write(&path, old).unwrap();
    assert!(root.show("Dev/a", &key).is_err());
}

#[test]
fn removal_from_fresh_clone_counts_from_existing_ciphertext() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey::generate();
    root.insert("a", &Entry::parse("one"), &key).unwrap();
    root.insert_or_replace("a", &Entry::parse("two"), &key)
        .unwrap();
    let path = dir.path().join("a.osseal");
    let old = fs::read(&path).unwrap();
    fs::remove_file(dir.path().join(REVISION_FILE)).unwrap();

    root.rm_with_key("a", &key).unwrap();
    assert_eq!(root.revisions().unwrap().get("a"), Some(&3));
    fs::write(path, old).unwrap();
    assert!(root.show("a", &key).is_err());
}

#[test]
fn whitespace_aliases_share_one_revision_and_cannot_resurrect_a_removed_entry() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey::generate();
    // Existing versions could bind the untrimmed name into the ciphertext.
    root.insert("  a  ", &Entry::parse("secret"), &key).unwrap();
    let path = dir.path().join("a.osseal");
    let old = fs::read(&path).unwrap();
    assert_eq!(root.show("  a  ", &key).unwrap().secret, "secret");
    root.rm_with_key("a", &key).unwrap();
    fs::write(&path, &old).unwrap();
    assert!(root.show("  a  ", &key).is_err());

    // A fresh clone has no local sidecar; removal still records the canonical
    // identity even when the authenticated ciphertext used an older spelling.
    fs::remove_file(dir.path().join(REVISION_FILE)).unwrap();
    root.rm_with_key("a", &key).unwrap();
    fs::write(&path, old).unwrap();
    assert!(root.show("  a  ", &key).is_err());
}

#[test]
fn equivalent_entry_spelling_can_read_and_recover_authenticated_ciphertext() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey::generate();
    root.insert("  a  ", &Entry::parse("secret"), &key).unwrap();
    assert_eq!(root.show("a", &key).unwrap().secret, "secret");
    let path = dir.path().join("a.osseal");
    root.next_entry_revision_after("a", &path, &key, 0, None, false)
        .unwrap();
    assert!(root.show("a", &key).is_err());
    root.recover_entry_trusting_ciphertext("a", &key).unwrap();
    assert_eq!(root.show("a", &key).unwrap().secret, "secret");
}

#[test]
fn legacy_revision_aliases_fold_to_the_highest_counter() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey::generate();
    root.insert("  a  ", &Entry::parse("secret"), &key).unwrap();
    fs::write(dir.path().join(REVISION_FILE), br#"{"  a  ":1,"a":4}"#).unwrap();
    assert_eq!(root.revision("  a  ").unwrap(), Some(4));
    assert_eq!(root.show("  a  ", &key).unwrap().secret, "secret");
    // The authenticated witness remains authoritative over the tampered sidecar.
    // An owner may explicitly trust that old ciphertext and re-seal it above
    // every legacy alias rather than silently lowering the counter.
    root.recover_entry_trusting_ciphertext("  a  ", &key)
        .unwrap();
    assert_eq!(root.revisions().unwrap(), BTreeMap::from([("a".into(), 5)]));
    assert_eq!(root.show("  a  ", &key).unwrap().secret, "secret");
}

#[test]
fn interrupted_removal_is_fail_closed_and_can_be_retried() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey::generate();
    root.insert("a", &Entry::parse("secret"), &key).unwrap();
    let path = dir.path().join("a.osseal");
    let old = fs::read(&path).unwrap();

    // Model a stop after persisting the tombstone but before unlinking.
    root.tombstone_entry("a", &key).unwrap();
    assert_eq!(fs::read(&path).unwrap(), old);
    assert!(root.show("a", &key).is_err());
    root.rm_with_key("a", &key).unwrap();
    assert!(!path.exists());
    fs::write(&path, old).unwrap();
    assert!(root.show("a", &key).is_err());
}

#[test]
fn explicit_recovery_preserves_an_interrupted_non_git_entry() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey::generate();
    root.insert("a", &Entry::parse("secret"), &key).unwrap();
    let path = dir.path().join("a.osseal");
    let old = fs::read(&path).unwrap();
    root.tombstone_entry("a", &key).unwrap();

    assert!(root.show("a", &key).is_err());
    assert!(root
        .recover_entry_trusting_ciphertext("a", &ItemDataKey::generate())
        .is_err());
    assert_eq!(fs::read(&path).unwrap(), old);
    assert_eq!(root.revisions().unwrap().get("a"), Some(&2));

    root.recover_entry_trusting_ciphertext("a", &key).unwrap();
    assert_eq!(root.revisions().unwrap().get("a"), Some(&3));
    assert_eq!(root.show("a", &key).unwrap().secret, "secret");
    fs::write(&path, old).unwrap();
    assert!(root.show("a", &key).is_err());
}

#[test]
fn only_explicit_recovery_trusts_a_replayed_entry_version() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey::generate();
    root.insert("a", &Entry::parse("old"), &key).unwrap();
    let path = dir.path().join("a.osseal");
    let old = fs::read(&path).unwrap();
    root.insert_or_replace("a", &Entry::parse("new"), &key)
        .unwrap();
    fs::write(path, old).unwrap();
    assert!(root.show("a", &key).is_err());
    // This deliberate API re-authenticates but cannot prove this version is
    // fresh; the caller's independently checked trust is what authorizes it.
    root.recover_entry_trusting_ciphertext("a", &key).unwrap();
    assert_eq!(root.show("a", &key).unwrap().secret, "old");
    assert_eq!(root.revisions().unwrap().get("a"), Some(&3));
}

#[test]
fn exhausted_revision_does_not_remove_the_entry() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey::generate();
    root.insert("a", &Entry::parse("secret"), &key).unwrap();
    root.record_revision("a", u64::MAX).unwrap();
    let path = dir.path().join("a.osseal");
    let old = fs::read(&path).unwrap();
    assert!(root.rm_with_key("a", &key).is_err());
    assert_eq!(fs::read(path).unwrap(), old);
}

#[test]
fn revision_mutations_exclude_other_writers_and_first_read_bootstraps() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey::generate();
    root.insert("a", &Entry::parse("one"), &key).unwrap();
    fs::remove_file(dir.path().join(REVISION_FILE)).unwrap();
    let held = StoreLock::for_writing(dir.path(), "b", Some(&key)).unwrap();

    assert!(root.insert("b", &Entry::parse("two"), &key).is_err());
    assert!(root.show("a", &key).is_err());
    assert!(!dir.path().join(REVISION_FILE).exists());
    drop(held);
    assert_eq!(root.show("a", &key).unwrap().secret, "one");
    root.insert("b", &Entry::parse("two"), &key).unwrap();
    assert_eq!(root.revisions().unwrap().len(), 2);
}

#[test]
fn explicit_recovery_advances_the_outside_witness_and_requires_it() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey::generate();
    root.insert("a", &Entry::parse("one"), &key).unwrap();
    let path = dir.path().join("a.osseal");
    let old = fs::read(&path).unwrap();
    root.tombstone_entry("a", &key).unwrap();
    root.recover_entry_trusting_ciphertext("a", &key).unwrap();
    assert_eq!(root.entry_witness("a", &key).unwrap().revision, 3);
    fs::write(&path, &old).unwrap();
    assert!(root.show("a", &key).is_err());
    fs::remove_dir_all(root.witness_root().unwrap()).unwrap();
    assert!(root.recover_entry_trusting_ciphertext("a", &key).is_err());
    assert_eq!(fs::read(path).unwrap(), old);
}

#[test]
fn anchor_migration_accepts_an_authenticated_whitespace_alias_only_at_its_path() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey::generate();
    let ciphertext = seal_osseal(b"original\n", &key, "  a  ", 1).unwrap();
    fs::write(dir.path().join("a.osseal"), &ciphertext).unwrap();
    root.record_revision("  a  ", 1).unwrap();
    root.migrate_rollback_anchor(&key).unwrap();
    assert_eq!(root.show("  a  ", &key).unwrap().secret, "original");
    assert!(crate::envelope::open_osseal_for_path(&ciphertext, &key, "other", Some(1)).is_err());
}
