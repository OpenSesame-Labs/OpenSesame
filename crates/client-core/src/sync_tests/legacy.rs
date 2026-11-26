use super::*;

#[test]
fn legacy_migration_rejects_invalid_cursor_via_validate_cursor() {
    let key = DeviceKey::generate();
    let mut store = SyncStore::new("kept-device");
    store.put_local(&key, "item", b"original").unwrap();
    let before = store.to_persisted_json(&key).unwrap();

    // Valid snapshot so a bad caller device id is the only cursor migrate() checks.
    let valid = CiphertextSyncSnapshot::from_json(
        &serde_json::json!({
            "format": SNAPSHOT_FORMAT,
            "version": SNAPSHOT_VERSION,
            "exported_at_unix_ms": 1,
            "cursor": {"device_id": "legacy-device", "epoch": 1},
            "blobs": []
        })
        .to_string(),
    )
    .unwrap();

    let fixtures = [
        serde_json::json!({
            "cursor": {"device_id": "", "epoch": 0},
            "blobs": []
        }),
        serde_json::json!({
            "cursor": {"device_id": "x".repeat(129), "epoch": 0},
            "blobs": []
        }),
        serde_json::json!({
            "cursor": {
                "device_id": "legacy-device",
                "epoch": (i64::MAX as u64) + 1
            },
            "blobs": []
        }),
    ];

    for legacy in fixtures {
        let json = legacy.to_string();
        assert!(SyncStore::migrate_trusted_legacy_json(&key, &json).is_err());
        let device_id = legacy["cursor"]["device_id"].as_str().unwrap().to_owned();
        let epoch = legacy["cursor"]["epoch"].as_u64().unwrap();
        let cursor = SyncCursor {
            device_id: device_id.clone(),
            epoch,
        };
        let bound = sync_limits::validate_cursor(&cursor).unwrap_err();
        assert!(bound.to_string().contains("invalid sync cursor"), "{bound}");
        // Empty and 129-byte device ids skip cursor deserialization. migrate()
        // admits them only through validate_cursor. The overflow epoch is the
        // same predicate, applied by snapshot.validate before reseal.
        let migrated = if epoch > i64::MAX as u64 {
            let snapshot = CiphertextSyncSnapshot::new(cursor, Vec::new(), None, 1);
            SyncStore::migrate_trusted_legacy_snapshot(&key, "kept-device", &snapshot)
        } else {
            SyncStore::migrate_trusted_legacy_snapshot(&key, device_id, &valid)
        };
        let rejected = match migrated {
            Err(error) => error,
            Ok(_) => panic!("invalid cursor was migrated"),
        };
        assert_eq!(rejected.to_string(), bound.to_string());
    }

    assert_eq!(store.to_persisted_json(&key).unwrap(), before);
    assert_eq!(
        open_sync_blob(&key, &store.opaque_blobs()[0]).unwrap(),
        b"original"
    );
}

#[test]
fn legacy_migration_rejects_ciphertext_that_would_exceed_v2_admission() {
    let key = DeviceKey::generate();
    let id = "edge";
    let pt_len = sync_auth::LEGACY_MIGRATION_CIPHERTEXT_MAX - 40 + 1;
    let plaintext = vec![0u8; pt_len];
    let legacy_cipher = seal(&key, &plaintext, id.as_bytes()).unwrap();
    assert!(legacy_cipher.len() > sync_auth::LEGACY_MIGRATION_CIPHERTEXT_MAX);
    let legacy = serde_json::json!({
        "cursor": {"device_id": "legacy-device", "epoch": 1},
        "blobs": [{"id": id, "epoch": 1, "ciphertext": legacy_cipher}]
    });
    assert!(SyncStore::migrate_trusted_legacy_json(&key, &legacy.to_string()).is_err());
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
fn two_independent_legacy_migrations_apply_onto_each_other() {
    let key = DeviceKey::generate();
    let legacy_cipher = seal(&key, b"legacy-secret", b"item").unwrap();
    let legacy = serde_json::json!({
        "cursor": {"device_id": "legacy-device", "epoch": 9},
        "blobs": [{"id": "item", "epoch": 7, "ciphertext": legacy_cipher}]
    })
    .to_string();
    let left = SyncStore::migrate_trusted_legacy_json(&key, &legacy).unwrap();
    let right = SyncStore::migrate_trusted_legacy_json(&key, &legacy).unwrap();
    assert_eq!(left.opaque_blobs(), right.opaque_blobs());
    let mut reconciled = SyncStore::new("peer");
    reconciled.apply_remote(&key, &left.opaque_blobs()).unwrap();
    reconciled
        .apply_remote(&key, &right.opaque_blobs())
        .unwrap();
    assert_eq!(
        open_sync_blob(&key, &reconciled.opaque_blobs()[0]).unwrap(),
        b"legacy-secret"
    );
}

#[test]
fn divergent_legacy_plaintext_at_same_id_rejects_on_sync() {
    let key = DeviceKey::generate();
    let cipher_a = seal(&key, b"device-a", b"item").unwrap();
    let cipher_b = seal(&key, b"device-b", b"item").unwrap();
    let legacy_a = serde_json::json!({
        "cursor": {"device_id": "legacy", "epoch": 1},
        "blobs": [{"id": "item", "epoch": 1, "ciphertext": cipher_a}]
    })
    .to_string();
    let legacy_b = serde_json::json!({
        "cursor": {"device_id": "legacy", "epoch": 1},
        "blobs": [{"id": "item", "epoch": 1, "ciphertext": cipher_b}]
    })
    .to_string();
    let mut left = SyncStore::migrate_trusted_legacy_json(&key, &legacy_a).unwrap();
    let right = SyncStore::migrate_trusted_legacy_json(&key, &legacy_b).unwrap();
    assert_ne!(
        left.opaque_blobs()[0].ciphertext,
        right.opaque_blobs()[0].ciphertext
    );
    assert!(left.apply_remote(&key, &right.opaque_blobs()).is_err());
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
