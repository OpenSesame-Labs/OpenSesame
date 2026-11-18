use super::*;
use opensesame_human_vault::{encrypt_item, AssociatedData, ENVELOPE_VERSION};
use std::fs;

fn legacy_blob(key: &ItemDataKey, plaintext: &[u8], revision: u64) -> Vec<u8> {
    let ad = AssociatedData {
        envelope_version: ENVELOPE_VERSION,
        item_id: "sealed-store-entry".into(),
        organization_id: "local".into(),
        project_id: "store".into(),
        collection_id: "entries".into(),
        key_id: "idk".into(),
        revision,
    };
    let envelope = encrypt_item(key, plaintext, ad).unwrap();
    let mut blob = crate::OSSEAL_MAGIC.to_vec();
    blob.extend(serde_json::to_vec(&serde_json::json!({ "envelope": envelope })).unwrap());
    blob
}

fn setup() -> (tempfile::TempDir, StoreRoot, ItemDataKey) {
    let dir = tempfile::tempdir().unwrap();
    let root = StoreRoot::open(dir.path()).unwrap();
    fs::create_dir(dir.path().join("Dev")).unwrap();
    (dir, root, ItemDataKey::generate())
}

#[test]
fn ordinary_reads_refuse_unbound_ciphertext_at_every_name() {
    let (dir, root, key) = setup();
    let old = legacy_blob(&key, b"legacy secret\n", 1);
    assert!(crate::envelope::open_osseal_in(
        crate::envelope::COLLECTION_ENTRIES,
        &old,
        &key,
        "sealed-store-entry",
        Some(1),
    )
    .is_err());
    for path in ["Dev/a.osseal", "Dev/b.osseal", "sealed-store-entry.osseal"] {
        fs::write(dir.path().join(path), &old).unwrap();
    }
    for name in ["Dev/a", "Dev/b", "sealed-store-entry"] {
        let error = root.show(name, &key).unwrap_err();
        assert!(error.to_string().contains("no authenticated name"));
    }
    assert!(!dir.path().join(".opensesame-revisions.json").exists());
    assert_eq!(fs::read(dir.path().join("Dev/b.osseal")).unwrap(), old);
}

#[test]
fn explicit_migration_binds_the_verified_name_and_rejects_replay() {
    let (dir, root, key) = setup();
    let old = legacy_blob(&key, b"legacy secret\n", 1);
    fs::write(dir.path().join("Dev/a.osseal"), &old).unwrap();
    let wrong = ItemDataKey::generate();
    assert!(root
        .migrate_legacy_entry_trusting_name("Dev/a", &wrong)
        .is_err());
    assert!(!dir.path().join(".opensesame-revisions.json").exists());
    assert_eq!(fs::read(dir.path().join("Dev/a.osseal")).unwrap(), old);

    root.migrate_legacy_entry_trusting_name("Dev/a", &key)
        .unwrap();
    assert_eq!(root.show("Dev/a", &key).unwrap().secret, "legacy secret");
    let migrated = fs::read(dir.path().join("Dev/a.osseal")).unwrap();
    assert_ne!(migrated, old);
    assert!(root
        .migrate_legacy_entry_trusting_name("Dev/a", &key)
        .is_err());
    fs::write(dir.path().join("Dev/b.osseal"), &migrated).unwrap();
    assert!(root.show("Dev/b", &key).is_err());
    fs::write(dir.path().join("Dev/a.osseal"), &old).unwrap();
    assert!(root.show("Dev/a", &key).is_err());
}

#[test]
fn the_old_generic_item_id_cannot_collide_with_a_real_entry_name() {
    let (dir, root, key) = setup();
    // Earlier name-bound versions could also create this literal name with
    // a revision above one; it remains ambiguous with the generic marker.
    let old = legacy_blob(&key, b"old value\n", 7);
    fs::write(dir.path().join("sealed-store-entry.osseal"), old).unwrap();
    root.record_revision("sealed-store-entry", 7).unwrap();
    assert!(root.show("sealed-store-entry", &key).is_err());
    root.migrate_legacy_entry_trusting_name("  sealed-store-entry  ", &key)
        .unwrap();
    assert_eq!(
        root.revisions().unwrap().get("sealed-store-entry"),
        Some(&8)
    );
    let rebound = fs::read(dir.path().join("sealed-store-entry.osseal")).unwrap();
    let body: serde_json::Value =
        serde_json::from_slice(&rebound[crate::OSSEAL_MAGIC.len()..]).unwrap();
    // An old reader must not see the generic item id and auto-rebind this
    // new ciphertext back into the old, replayable format.
    assert_ne!(body["envelope"]["ad"]["item_id"], "sealed-store-entry");
    fs::write(dir.path().join("sealed-store-entry@v2.osseal"), &rebound).unwrap();
    assert!(root.show("sealed-store-entry@v2", &key).is_err());
    assert_eq!(
        root.show("sealed-store-entry", &key).unwrap().secret,
        "old value"
    );
    root.insert_or_replace(
        "sealed-store-entry",
        &crate::Entry::parse("new value\n"),
        &key,
    )
    .unwrap();
    assert_eq!(
        root.show("sealed-store-entry", &key).unwrap().secret,
        "new value"
    );
}

#[test]
fn migration_rejects_modern_entries_and_concurrent_writers() {
    let (dir, root, key) = setup();
    let bound = seal_osseal(b"modern\n", &key, "Dev/a", 1).unwrap();
    fs::write(dir.path().join("Dev/a.osseal"), &bound).unwrap();
    assert!(root
        .migrate_legacy_entry_trusting_name("Dev/a", &key)
        .is_err());
    assert_eq!(fs::read(dir.path().join("Dev/a.osseal")).unwrap(), bound);

    let old = legacy_blob(&key, b"legacy\n", 1);
    fs::write(dir.path().join("Dev/a.osseal"), &old).unwrap();
    let _writer = StoreLock::for_sealing(&root.path, "Dev/a", &key).unwrap();
    assert!(root
        .migrate_legacy_entry_trusting_name("Dev/a", &key)
        .is_err());
    assert_eq!(fs::read(dir.path().join("Dev/a.osseal")).unwrap(), old);
}

#[test]
fn migration_advances_a_preexisting_revision_witness() {
    let (dir, root, key) = setup();
    root.record_revision("Dev/a", 7).unwrap();
    fs::write(
        dir.path().join("Dev/a.osseal"),
        legacy_blob(&key, b"verified\n", 1),
    )
    .unwrap();
    root.migrate_legacy_entry_trusting_name("Dev/a", &key)
        .unwrap();
    assert_eq!(root.revisions().unwrap().get("Dev/a"), Some(&8));
    assert_eq!(root.show("Dev/a", &key).unwrap().secret, "verified");
}

#[test]
fn root_rotation_refuses_to_rebind_legacy_entries_implicitly() {
    let dir = tempfile::tempdir().unwrap();
    let root = crate::init_store(dir.path(), &[]).unwrap();
    let password = b"correct horse battery staple";
    let key = crate::init_store_key(dir.path(), password).unwrap();
    let old = legacy_blob(&key, b"legacy\n", 1);
    let entry_path = dir.path().join("entry.osseal");
    fs::write(&entry_path, &old).unwrap();
    let key_path = dir.path().join(".opensesame-key");
    let key_before = fs::read(&key_path).unwrap();
    let error = crate::rotate_store_root(dir.path(), password, crate::RotationEdit::default())
        .err()
        .expect("rotation must reject an unbound entry");
    assert!(error.to_string().contains("no authenticated name"));
    assert_eq!(fs::read(entry_path).unwrap(), old);
    assert_eq!(fs::read(key_path).unwrap(), key_before);
    assert!(root.show("entry", &key).is_err());
}
