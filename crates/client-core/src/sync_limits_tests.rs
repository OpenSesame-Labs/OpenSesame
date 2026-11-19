use super::*;
use crate::{
    CiphertextSyncSnapshot, ClientCoreError, DeviceKey, SyncBlob, SyncStore, SNAPSHOT_FORMAT,
    SNAPSHOT_VERSION,
};
use serde::de::Visitor;
use serde_json::{json, Value};

fn snapshot(blobs: Vec<Value>) -> Value {
    json!({
        "format": SNAPSHOT_FORMAT,
        "version": SNAPSHOT_VERSION,
        "exported_at_unix_ms": 1,
        "cursor": {"device_id": "device", "epoch": 0},
        "blobs": blobs,
    })
}

#[test]
fn unknown_fields_are_rejected_during_deserialization() {
    let mut item = json!({"id": "entry", "epoch": 1, "ciphertext": [1]});
    item["extra"] = json!(1);
    assert!(CiphertextSyncSnapshot::from_json(&snapshot(vec![item]).to_string()).is_err());
    let persisted = json!({
        "version": 2,
        "cursor": {"device_id": "device", "epoch": 0},
        "blobs": [{"id": "entry", "epoch": 1, "ciphertext": [1], "extra": 1}],
        "integrity": "00".repeat(32),
    });
    assert!(
        SyncStore::from_persisted_json(&DeviceKey::generate(), &persisted.to_string()).is_err()
    );
    let mut bad_cursor = snapshot(vec![]);
    bad_cursor["cursor"]["extra"] = json!(1);
    assert!(CiphertextSyncSnapshot::from_json(&bad_cursor.to_string()).is_err());
}

#[test]
fn json_parsers_reject_excess_counts_and_bounded_strings() {
    let item = json!({"id": "entry", "epoch": 1, "ciphertext": [1]});
    let too_many = snapshot(vec![item.clone(); MAX_SYNC_BLOBS + 1]).to_string();
    assert!(CiphertextSyncSnapshot::from_json(&too_many).is_err());
    let persisted = json!({
        "version": 2, "cursor": {"device_id": "device", "epoch": 0},
        "blobs": vec![item.clone(); MAX_SYNC_BLOBS + 1], "integrity": "00".repeat(32)
    })
    .to_string();
    assert!(SyncStore::from_persisted_json(&DeviceKey::generate(), &persisted).is_err());
    let mut long_id = item;
    long_id["id"] = json!("x".repeat(MAX_SYNC_ID_BYTES + 1));
    assert!(CiphertextSyncSnapshot::from_json(&snapshot(vec![long_id]).to_string()).is_err());
    let mut long_device = snapshot(vec![]);
    long_device["cursor"]["device_id"] = json!("x".repeat(MAX_SYNC_DEVICE_ID_BYTES + 1));
    assert!(CiphertextSyncSnapshot::from_json(&long_device.to_string()).is_err());
    let mut long_project = snapshot(vec![]);
    long_project["project_id"] = json!("x".repeat(MAX_SYNC_PROJECT_ID_BYTES + 1));
    assert!(CiphertextSyncSnapshot::from_json(&long_project.to_string()).is_err());
}

#[test]
fn ciphertext_is_bounded_during_deserialization() {
    let item =
        json!({"id": "entry", "epoch": 1, "ciphertext": vec![1_u8; MAX_SYNC_CIPHERTEXT_BYTES + 1]});
    let error = CiphertextSyncSnapshot::from_json(&snapshot(vec![item]).to_string()).unwrap_err();
    assert!(error.to_string().contains("ciphertext exceeds"));
}

#[test]
fn local_store_count_limit_fails_without_advancing_the_cursor() {
    let key = DeviceKey::generate();
    let mut store = SyncStore::new("device");
    for i in 0..MAX_SYNC_BLOBS {
        store.put_local(&key, format!("item-{i}"), b"x").unwrap();
    }
    let epoch = store.cursor().epoch;
    assert!(store.put_local(&key, "one-too-many", b"x").is_err());
    assert_eq!(store.cursor().epoch, epoch);
    assert_eq!(store.opaque_blobs().len(), MAX_SYNC_BLOBS);
    // Replacing an existing item remains possible at the count ceiling.
    assert!(store.put_local(&key, "item-0", b"replacement").is_ok());
}

#[test]
fn aggregate_bytes_and_direct_batches_are_bounded_before_decryption() {
    let key = DeviceKey::generate();
    let mut store = SyncStore::new("device");
    let blobs: Vec<_> = (0..(MAX_SYNC_TOTAL_BYTES / MAX_SYNC_CIPHERTEXT_BYTES + 1))
        .map(|i| SyncBlob {
            id: format!("item-{i}"),
            epoch: 1,
            ciphertext: vec![0; MAX_SYNC_CIPHERTEXT_BYTES],
        })
        .collect();
    assert!(store.apply_remote(&key, &blobs).is_err());
    assert!(store.opaque_blobs().is_empty());
    assert_eq!(store.cursor().epoch, 0);
    assert!(check_json_size(MAX_SYNC_JSON_BYTES).is_ok());
    assert!(check_json_size(MAX_SYNC_JSON_BYTES + 1).is_err());
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn native_load_rejects_an_oversized_file_before_reading_it() {
    let file = tempfile::NamedTempFile::new().unwrap();
    file.as_file()
        .set_len(MAX_SYNC_JSON_BYTES as u64 + 1)
        .unwrap();
    let error = match SyncStore::load_path(&DeviceKey::generate(), file.path()) {
        Err(error) => error,
        Ok(_) => panic!("oversized file was accepted"),
    };
    assert!(error.to_string().contains("oversized sync file"));
}

#[test]
fn persisted_load_rejects_wrong_key_for_mutations() {
    let key_a = DeviceKey::generate();
    let key_b = DeviceKey::generate();
    let mut store = SyncStore::new("device");
    store.put_local(&key_a, "item", b"secret").unwrap();
    let json = store.to_persisted_json(&key_a).unwrap();

    let mut loaded = SyncStore::from_persisted_json(&key_a, &json).unwrap();
    assert_eq!(loaded.opaque_blobs().len(), 1);
    assert!(loaded.put_local(&key_a, "item-2", b"x").is_ok());
    expect_wrong_key_on_mutations(&mut loaded, &key_b);

    #[cfg(not(target_arch = "wasm32"))]
    {
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), &json).unwrap();
        let mut from_disk = SyncStore::load_path(&key_a, file.path()).unwrap();
        assert_eq!(from_disk.opaque_blobs().len(), 1);
        expect_wrong_key_on_mutations(&mut from_disk, &key_b);
    }
}

fn expect_wrong_key_on_mutations(store: &mut SyncStore, foreign: &DeviceKey) {
    let epoch = store.cursor().epoch;
    let blobs = store.opaque_blobs();
    expect_wrong_key(store.put_local(foreign, "other", b"nope"));
    expect_wrong_key(store.apply_remote(
        foreign,
        &[SyncBlob {
            id: "probe".into(),
            epoch: 1,
            ciphertext: vec![1],
        }],
    ));
    expect_wrong_key(store.to_persisted_json(foreign));
    assert_eq!(store.cursor().epoch, epoch);
    assert_eq!(store.opaque_blobs(), blobs);
}

fn bounded_blob_error(value: Value) -> String {
    match serde_json::from_value::<BoundedBlob>(value) {
        Ok(_) => panic!("expected bounded blob to be rejected"),
        Err(error) => error.to_string(),
    }
}

fn expect_wrong_key<T: std::fmt::Debug>(result: Result<T, ClientCoreError>) {
    match result {
        Err(ClientCoreError::WrongKey) => {}
        other => panic!("expected WrongKey, got {other:?}"),
    }
}

#[test]
fn bounded_blob_rejects_invalid_epoch() {
    for epoch in [0, (i64::MAX as u64) + 1, u64::MAX] {
        let item = json!({"id": "entry", "epoch": epoch, "ciphertext": [1]});
        let direct = bounded_blob_error(item.clone());
        assert!(direct.contains("invalid sync epoch"), "{direct}");
        let via_snapshot =
            CiphertextSyncSnapshot::from_json(&snapshot(vec![item]).to_string()).unwrap_err();
        assert!(
            via_snapshot.to_string().contains("invalid sync epoch"),
            "{via_snapshot}"
        );
    }

    let max_epoch = i64::MAX as u64;
    let accepted: BoundedBlob =
        serde_json::from_value(json!({"id": "entry", "epoch": max_epoch, "ciphertext": [1]}))
            .unwrap();
    assert_eq!(accepted.epoch, max_epoch);
    // Public `SyncBlob` stays permissive; admission limits live on `BoundedBlob`.
    let wire: SyncBlob =
        serde_json::from_value(json!({"id": "entry", "epoch": 0, "ciphertext": []})).unwrap();
    assert_eq!(wire.epoch, 0);
}

#[test]
fn ciphertext_bytes_form_respects_limit() {
    let blob: BoundedBlob = serde_json::from_value(json!({
        "id": "entry",
        "epoch": 1,
        "ciphertext": [1, 2, 3],
    }))
    .unwrap();
    assert_eq!(blob.ciphertext, [1, 2, 3]);

    // serde_json strings take the `visit_bytes` path of `deserialize_bytes`.
    let from_string: BoundedBlob =
        serde_json::from_str(r#"{"id":"entry","epoch":1,"ciphertext":"abc"}"#).unwrap();
    assert_eq!(from_string.ciphertext, b"abc");

    let empty = bounded_blob_error(json!({
        "id": "entry",
        "epoch": 1,
        "ciphertext": [],
    }));
    assert!(empty.contains("empty"), "{empty}");

    let oversized = vec![1_u8; MAX_SYNC_CIPHERTEXT_BYTES + 1];
    let over = deserialize_ciphertext(
        serde::de::value::BytesDeserializer::<serde::de::value::Error>::new(&oversized),
    )
    .unwrap_err();
    assert!(over.to_string().contains("ciphertext exceeds"), "{over}");
    let empty_bytes = deserialize_ciphertext(serde::de::value::BytesDeserializer::<
        serde::de::value::Error,
    >::new(&[]))
    .unwrap_err();
    assert!(empty_bytes.to_string().contains("empty"), "{empty_bytes}");

    // serde_json only hits `visit_seq` for arrays and `visit_bytes` for strings.
    // `visit_byte_buf` (wasm `Uint8Array`) is covered by `assert_visit_byte_buf_respects_limit`.
    assert_visit_byte_buf_respects_limit();
}

/// Direct `visit_byte_buf` coverage. serde_json does not call this visitor method.
fn assert_visit_byte_buf_respects_limit() {
    let accepted = super::BytesVisitor
        .visit_byte_buf::<serde::de::value::Error>(vec![1, 2, 3])
        .unwrap();
    assert_eq!(accepted, vec![1, 2, 3]);
    let empty = super::BytesVisitor
        .visit_byte_buf::<serde::de::value::Error>(Vec::new())
        .unwrap_err();
    assert!(empty.to_string().contains("empty"), "{empty}");
    let over = super::BytesVisitor
        .visit_byte_buf::<serde::de::value::Error>(vec![0; MAX_SYNC_CIPHERTEXT_BYTES + 1])
        .unwrap_err();
    assert!(over.to_string().contains("ciphertext exceeds"), "{over}");
}

#[test]
fn cumulative_capacity_accounts_for_existing_entries_and_replacements() {
    let mut entries = BTreeMap::new();
    for i in 0..(MAX_SYNC_TOTAL_BYTES / MAX_SYNC_CIPHERTEXT_BYTES) {
        entries.insert(format!("item-{i}"), (1, vec![0; MAX_SYNC_CIPHERTEXT_BYTES]));
    }
    let new_item = SyncBlob {
        id: "new".into(),
        epoch: 2,
        ciphertext: vec![1],
    };
    assert!(validate_capacity(&entries, &[new_item]).is_err());
    let replacement = SyncBlob {
        id: "item-0".into(),
        epoch: 2,
        ciphertext: vec![1],
    };
    assert!(validate_capacity(&entries, &[replacement]).is_ok());
}
