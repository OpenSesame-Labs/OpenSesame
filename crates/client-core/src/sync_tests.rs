use super::*;

#[test]
fn seal_open_roundtrip() {
    let key = DeviceKey::generate();
    let sealed = seal(&key, b"secret", b"item-1").unwrap();
    assert_ne!(&sealed[24..], b"secret");
    assert_eq!(open(&key, &sealed, b"item-1").unwrap(), b"secret");
}

#[test]
fn sync_preserves_ids_and_epochs() {
    let key = DeviceKey::generate();
    let mut a = SyncStore::new("dev-a");
    let blob = a.put_local(&key, "note-1", b"hello").unwrap();
    let mut b = SyncStore::new("dev-b");
    b.apply_remote(&key, std::slice::from_ref(&blob)).unwrap();
    assert_eq!(b.entries.get("note-1").unwrap().0, blob.epoch);
    let out = b.collect_outgoing(&SyncCursor {
        device_id: "x".into(),
        epoch: 0,
    });
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].id, "note-1");
}

#[test]
fn server_view_is_ciphertext_only() {
    let key = DeviceKey::generate();
    let mut store = SyncStore::new("d");
    let blob = store
        .put_local(&key, "x", b"plaintext-should-not-leak")
        .unwrap();
    let json = serde_json::to_string(&blob).unwrap();
    assert!(!json.contains("plaintext-should-not-leak"));
}

#[test]
fn multi_device_cursor_monotonic() {
    let key = DeviceKey::generate();
    let mut a = SyncStore::new("dev-a");
    let mut b = SyncStore::new("dev-b");
    let b1 = a.put_local(&key, "n1", b"one").unwrap();
    b.apply_remote(&key, &[b1]).unwrap();
    let e1 = b.cursor.epoch;
    let b2 = a.put_local(&key, "n2", b"two").unwrap();
    b.apply_remote(&key, &[b2]).unwrap();
    assert!(b.cursor.epoch >= e1);
    let since = SyncCursor {
        device_id: "dev-b".into(),
        epoch: e1,
    };
    let out = b.collect_outgoing(&since);
    assert_eq!(out.len(), 2);
    for blob in &out {
        let json = serde_json::to_string(blob).unwrap();
        assert!(!json.contains("one"));
        assert!(!json.contains("two"));
    }
}

#[test]
fn outgoing_reconciliation_includes_independent_lower_and_equal_epochs() {
    let key = DeviceKey::generate();
    let mut a = SyncStore::new("a");
    let mut b = SyncStore::new("b");
    a.put_local(&key, "a", b"a1").unwrap();
    let b1 = b.put_local(&key, "b", b"b1").unwrap();
    assert_eq!(a.cursor().epoch, b1.epoch);
    assert_eq!(b.collect_outgoing(a.cursor()), vec![b1.clone()]);
    a.put_local(&key, "a", b"a2").unwrap();
    assert!(a.cursor().epoch > b1.epoch);
    let outgoing = b.collect_outgoing(a.cursor());
    assert_eq!(outgoing, vec![b1]);
    a.apply_remote(&key, &outgoing).unwrap();
    assert!(a.opaque_blobs().iter().any(|blob| blob.id == "b"));
}

#[test]
fn persist_roundtrip_ciphertext_only() {
    let key = DeviceKey::generate();
    let mut store = SyncStore::new("persist-dev");
    store.put_local(&key, "n1", b"secret-payload-xyz").unwrap();
    let json = store.to_persisted_json(&key).unwrap();
    assert!(!json.contains("secret-payload-xyz"));
    let loaded = SyncStore::from_persisted_json(&key, &json).unwrap();
    assert_eq!(loaded.cursor.device_id, "persist-dev");
    assert_eq!(loaded.entries.len(), 1);

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sync.json");
    store.save_path(&key, &path).unwrap();
    let from_disk = SyncStore::load_path(&key, &path).unwrap();
    assert_eq!(from_disk.cursor.epoch, store.cursor.epoch);
    let disk_json = std::fs::read_to_string(&path).unwrap();
    assert!(!disk_json.contains("secret-payload-xyz"));
}

#[test]
fn opaque_blobs_match_server_view() {
    let key = DeviceKey::generate();
    let mut store = SyncStore::new("opaque-dev");
    let blob = store.put_local(&key, "item-1", b"never-on-wire").unwrap();
    let opaque = store.opaque_blobs();
    assert_eq!(opaque.len(), 1);
    assert_eq!(opaque[0].id, blob.id);
    assert_eq!(opaque[0].ciphertext, blob.ciphertext);
    let wire = serde_json::to_string(&opaque[0]).unwrap();
    assert!(!wire.contains("never-on-wire"));
}

#[test]
fn forged_epochs_are_rejected_atomically_before_conflict_resolution() {
    let key = DeviceKey::generate();
    let mut source = SyncStore::new("source");
    let old = source.put_local(&key, "item", b"old").unwrap();
    let newest = source.put_local(&key, "item", b"new").unwrap();
    let other = source.put_local(&key, "other", b"other").unwrap();
    let mut destination = SyncStore::new("destination");
    destination
        .apply_remote(&key, std::slice::from_ref(&newest))
        .unwrap();
    let before = destination.to_persisted_json(&key).unwrap();

    for forged_epoch in [newest.epoch + 100, u64::MAX] {
        let mut forged = old.clone();
        forged.epoch = forged_epoch;
        assert!(destination
            .apply_remote(&key, &[other.clone(), forged])
            .is_err());
        assert_eq!(destination.to_persisted_json(&key).unwrap(), before);
        assert_eq!(
            open_sync_blob(&key, &destination.opaque_blobs()[0]).unwrap(),
            b"new"
        );
    }
}

#[test]
fn persisted_metadata_and_key_changes_are_refused() {
    let key = DeviceKey::generate();
    let foreign = DeviceKey::generate();
    let mut store = SyncStore::new("device-a");
    store.put_local(&key, "note", b"secret").unwrap();
    let before = store.to_persisted_json(&key).unwrap();
    assert!(store.put_local(&foreign, "other", b"x").is_err());
    assert!(store.to_persisted_json(&foreign).is_err());
    assert!(SyncStore::from_persisted_json(&foreign, &before).is_err());
    for (field, value) in [
        ("epoch", serde_json::json!(u64::MAX)),
        ("device_id", serde_json::json!("other-device")),
    ] {
        let mut tampered: serde_json::Value = serde_json::from_str(&before).unwrap();
        tampered["cursor"][field] = value;
        assert!(SyncStore::from_persisted_json(&key, &tampered.to_string()).is_err());
    }
    assert_eq!(store.to_persisted_json(&key).unwrap(), before);
}

#[test]
fn empty_authenticated_stores_are_bound_to_their_key() {
    let key = DeviceKey::generate();
    let foreign = DeviceKey::generate();
    let mut store = SyncStore::new("empty");
    let json = store.to_persisted_json(&key).unwrap();
    assert!(matches!(
        store.to_persisted_json(&foreign),
        Err(ClientCoreError::WrongKey)
    ));
    assert!(matches!(
        store.put_local(&foreign, "item", b"wrong"),
        Err(ClientCoreError::WrongKey)
    ));
    assert!(SyncStore::from_persisted_json(&foreign, &json).is_err());

    let mut loaded = SyncStore::from_persisted_json(&key, &json).unwrap();
    assert!(matches!(
        loaded.put_local(&foreign, "item", b"wrong"),
        Err(ClientCoreError::WrongKey)
    ));
    loaded.put_local(&key, "item", b"right").unwrap();

    let legacy = r#"{"cursor":{"device_id":"legacy","epoch":0},"blobs":[]}"#;
    let mut migrated = SyncStore::migrate_trusted_legacy_json(&key, legacy).unwrap();
    assert!(matches!(
        migrated.put_local(&foreign, "item", b"wrong"),
        Err(ClientCoreError::WrongKey)
    ));
}

#[test]
fn concurrent_empty_serializers_cannot_bind_different_keys() {
    let store = SyncStore::new("empty");
    let first = DeviceKey::generate();
    let second = DeviceKey::generate();
    let barrier = std::sync::Barrier::new(2);
    std::thread::scope(|scope| {
        let a = scope.spawn(|| {
            barrier.wait();
            store.to_persisted_json(&first)
        });
        let b = scope.spawn(|| {
            barrier.wait();
            store.to_persisted_json(&second)
        });
        match (a.join().unwrap(), b.join().unwrap()) {
            (Ok(json), Err(ClientCoreError::WrongKey)) => {
                assert!(SyncStore::from_persisted_json(&first, &json).is_ok());
            }
            (Err(ClientCoreError::WrongKey), Ok(json)) => {
                assert!(SyncStore::from_persisted_json(&second, &json).is_ok());
            }
            _ => panic!("exactly one key must bind the empty store"),
        }
    });
}

#[test]
fn equal_epoch_conflicts_fail_atomically_but_identical_retries_succeed() {
    let key = DeviceKey::generate();
    let mut a = SyncStore::new("a");
    let mut b = SyncStore::new("b");
    let first = a.put_local(&key, "item", b"first").unwrap();
    let second = b.put_local(&key, "item", b"second").unwrap();
    let other = a.put_local(&key, "other", b"other").unwrap();
    assert_eq!(first.epoch, second.epoch);

    let mut destination = SyncStore::new("destination");
    destination
        .apply_remote(&key, std::slice::from_ref(&first))
        .unwrap();
    let before = destination.to_persisted_json(&key).unwrap();
    assert!(matches!(
        destination.apply_remote(&key, &[other.clone(), second.clone()]),
        Err(ClientCoreError::InvalidBlob(_))
    ));
    assert_eq!(destination.to_persisted_json(&key).unwrap(), before);
    assert_eq!(
        destination
            .apply_authenticated(&key, &[first.clone(), first.clone()])
            .unwrap(),
        0
    );

    let mut empty = SyncStore::new("empty");
    assert!(matches!(
        empty.apply_remote(&key, &[other, first.clone(), second]),
        Err(ClientCoreError::InvalidBlob(_))
    ));
    assert!(empty.opaque_blobs().is_empty());
    assert_eq!(empty.cursor().epoch, 0);
    assert_eq!(
        empty
            .apply_authenticated(&key, &[first.clone(), first])
            .unwrap(),
        1
    );
}

#[test]
fn snapshot_import_authenticates_epochs_and_does_not_partially_apply() {
    let key = DeviceKey::generate();
    let mut source = SyncStore::new("source");
    let old = source.put_local(&key, "item", b"old").unwrap();
    source.put_local(&key, "item", b"new").unwrap();
    let mut destination = SyncStore::new("destination");
    let current = destination.put_local(&key, "existing", b"keep").unwrap();
    let before = destination.to_persisted_json(&key).unwrap();
    let mut forged = old;
    forged.epoch = 999;
    let snapshot =
        CiphertextSyncSnapshot::new(source.cursor().clone(), vec![current, forged], None, 1);
    assert!(destination
        .import_ciphertext_snapshot(&key, &snapshot)
        .is_err());
    assert_eq!(destination.to_persisted_json(&key).unwrap(), before);
}

#[test]
fn legacy_migration_is_explicit_and_assigns_new_authenticated_epochs() {
    let key = DeviceKey::generate();
    let foreign = DeviceKey::generate();
    let legacy_cipher = seal(&key, b"legacy-secret", b"item").unwrap();
    let legacy = serde_json::json!({
        "cursor": {"device_id": "legacy-device", "epoch": 9},
        "blobs": [{"id": "item", "epoch": 7, "ciphertext": legacy_cipher}]
    })
    .to_string();
    assert!(SyncStore::from_persisted_json(&key, &legacy).is_err());
    assert!(SyncStore::migrate_trusted_legacy_json(&foreign, &legacy).is_err());
    let migrated = SyncStore::migrate_trusted_legacy_json(&key, &legacy).unwrap();
    let blobs = migrated.opaque_blobs();
    assert_eq!(blobs[0].epoch, 10);
    assert_eq!(open_sync_blob(&key, &blobs[0]).unwrap(), b"legacy-secret");
    let saved = migrated.to_persisted_json(&key).unwrap();
    assert!(SyncStore::from_persisted_json(&key, &saved).is_ok());
    assert!(SyncStore::migrate_trusted_legacy_json(&key, &saved).is_err());
}

#[test]
fn exhausted_epoch_cannot_wrap_or_change_the_store() {
    let key = DeviceKey::generate();
    let mut store = SyncStore::new("device");
    store.put_local(&key, "item", b"unchanged").unwrap();
    store.cursor.epoch = i64::MAX as u64;
    let before = store.opaque_blobs();
    assert!(matches!(
        store.put_local(&key, "item", b"new"),
        Err(ClientCoreError::EpochExhausted)
    ));
    assert_eq!(store.opaque_blobs(), before);
    assert_eq!(store.cursor().epoch, i64::MAX as u64);
}

#[test]
fn trusted_legacy_snapshot_can_be_resealed_without_automatic_downgrade() {
    let key = DeviceKey::generate();
    let legacy = SyncBlob {
        id: "project:p:entry".into(),
        epoch: 3,
        ciphertext: seal(&key, b"legacy-snapshot", b"project:p:entry").unwrap(),
    };
    let snapshot = CiphertextSyncSnapshot::new(
        SyncCursor {
            device_id: "old-device".into(),
            epoch: 5,
        },
        vec![legacy],
        Some("p".into()),
        1,
    );
    let mut normal = SyncStore::new("new-device");
    assert!(normal.import_ciphertext_snapshot(&key, &snapshot).is_err());
    assert!(normal.opaque_blobs().is_empty());
    let migrated =
        SyncStore::migrate_trusted_legacy_snapshot(&key, "new-device", &snapshot).unwrap();
    assert_eq!(migrated.cursor().device_id, "new-device");
    assert_eq!(migrated.cursor().epoch, 6);
    assert_eq!(
        open_sync_blob(&key, &migrated.opaque_blobs()[0]).unwrap(),
        b"legacy-snapshot"
    );
}
