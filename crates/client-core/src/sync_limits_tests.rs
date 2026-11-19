use super::*;
use crate::{CiphertextSyncSnapshot, DeviceKey, SyncStore, SNAPSHOT_FORMAT, SNAPSHOT_VERSION};
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
        "integrity": "00".repeat(64),
    });
    assert!(SyncStore::from_persisted_json(&DeviceKey::generate(), &persisted.to_string()).is_err());
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
