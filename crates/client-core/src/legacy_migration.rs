//! Explicit migration of an operator-selected, trusted legacy sync export.

use std::collections::BTreeMap;
use zeroize::Zeroizing;

use crate::{
    open, sync_limits, CiphertextSyncSnapshot, ClientCoreError, DeviceKey, PersistedStore,
    SyncBlob, SyncCursor, SyncStore, sync_auth, MAX_SYNC_ID_BYTES,
};

impl SyncStore {
    /// Re-seal an old persisted store selected from a trusted offline source.
    /// Legacy epochs were never authenticated. The caller must establish the
    /// source's provenance and freshness, and must coordinate other devices
    /// before syncing the migrated data. This is never a network fallback.
    ///
    /// # Errors
    ///
    /// Returns an error for non-legacy, malformed, conflicting, or foreign-key data.
    pub fn migrate_trusted_legacy_json(
        key: &DeviceKey,
        json: &str,
    ) -> Result<Self, ClientCoreError> {
        crate::sync_limits::check_json_size(json.len())?;
        let legacy: PersistedStore = serde_json::from_str(json)
            .map_err(|error| ClientCoreError::Persist(error.to_string()))?;
        if legacy.version.is_some() || legacy.integrity.is_some() {
            return Err(ClientCoreError::Persist("not a legacy sync store".into()));
        }
        migrate(key, legacy.cursor, legacy.blobs)
    }

    /// Re-seal a trusted offline legacy snapshot for a named local device.
    /// The same provenance and coordination requirements as
    /// [`Self::migrate_trusted_legacy_json`] apply.
    ///
    /// # Errors
    ///
    /// Returns an error for malformed, conflicting, or foreign-key data.
    pub fn migrate_trusted_legacy_snapshot(
        key: &DeviceKey,
        device_id: impl Into<String>,
        snapshot: &CiphertextSyncSnapshot,
    ) -> Result<Self, ClientCoreError> {
        snapshot.validate()?;
        let cursor = SyncCursor {
            device_id: device_id.into(),
            epoch: snapshot.cursor.epoch,
        };
        migrate(key, cursor, snapshot.blobs.clone())
    }
}

fn migrate(
    key: &DeviceKey,
    cursor: SyncCursor,
    blobs: Vec<SyncBlob>,
) -> Result<SyncStore, ClientCoreError> {
    crate::sync_limits::validate_cursor(&cursor)?;
    crate::sync_limits::validate_blobs(&blobs)?;
    if cursor.device_id.is_empty() || cursor.device_id.len() > 128 || cursor.epoch > i64::MAX as u64
    {
        return Err(ClientCoreError::Persist(
            "invalid legacy sync cursor".into(),
        ));
    }
    let mut high = cursor.epoch;
    let mut latest: BTreeMap<String, SyncBlob> = BTreeMap::new();
    for blob in blobs {
        if blob.id.is_empty()
            || blob.id.len() > MAX_SYNC_ID_BYTES
            || blob.epoch == 0
            || blob.epoch > i64::MAX as u64
            || blob.ciphertext.len() > sync_auth::LEGACY_MIGRATION_CIPHERTEXT_MAX
        {
            return Err(ClientCoreError::InvalidBlob("invalid legacy sync blob"));
        }
        high = high.max(blob.epoch);
        match latest.get(&blob.id) {
            Some(previous) if previous.epoch > blob.epoch => continue,
            Some(previous)
                if previous.epoch == blob.epoch && previous.ciphertext != blob.ciphertext =>
            {
                return Err(ClientCoreError::InvalidBlob(
                    "conflicting legacy sync versions",
                ));
            }
            _ => {
                latest.insert(blob.id.clone(), blob);
            }
        }
    }
    let mut store = SyncStore::new(cursor.device_id);
    store.cursor.epoch = high;
    let empty = latest.is_empty();
    for (_, blob) in latest {
        let plaintext = Zeroizing::new(open(key, &blob.ciphertext, blob.id.as_bytes())?);
        store.put_local_migrated(key, blob.id, &plaintext)?;
    }
    if empty {
        store.remember_key(blake3::keyed_hash(
            key.as_bytes(),
            b"OpenSesame sync store key v2",
        ));
    }
    let migrated: Vec<SyncBlob> = store
        .entries
        .iter()
        .map(|(id, (epoch, ciphertext))| SyncBlob {
            id: id.clone(),
            epoch: *epoch,
            ciphertext: ciphertext.clone(),
        })
        .collect();
    sync_limits::validate_blobs(&migrated)?;
    Ok(store)
}
