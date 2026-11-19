//! Authenticate persisted metadata as well as each sealed sync blob.

use serde::Serialize;
use zeroize::Zeroizing;

use crate::{ClientCoreError, DeviceKey, PersistedStore, SyncBlob, SyncCursor};

pub(crate) const VERSION: u32 = 2;
const DOMAIN: &[u8] = b"OpenSesame persisted sync store v2\0";

#[derive(Serialize)]
struct Authenticated<'a> {
    version: u32,
    cursor: &'a SyncCursor,
    blobs: &'a [SyncBlob],
}

fn digest(key: &DeviceKey, value: &PersistedStore) -> Result<blake3::Hash, ClientCoreError> {
    let bytes = serde_json::to_vec(&Authenticated {
        version: VERSION,
        cursor: &value.cursor,
        blobs: &value.blobs,
    })
    .map_err(|error| ClientCoreError::Persist(error.to_string()))?;
    let mac_key = Zeroizing::new(*blake3::keyed_hash(key.as_bytes(), DOMAIN).as_bytes());
    let mut hash = blake3::Hasher::new_keyed(&mac_key);
    hash.update(DOMAIN);
    hash.update(&bytes);
    Ok(hash.finalize())
}

pub(crate) fn tag(key: &DeviceKey, value: &PersistedStore) -> Result<String, ClientCoreError> {
    crate::sync_limits::validate_cursor(&value.cursor)?;
    crate::sync_limits::validate_blobs(&value.blobs)?;
    Ok(digest(key, value)?.to_hex().to_string())
}

pub(crate) fn verify(key: &DeviceKey, value: &PersistedStore) -> Result<(), ClientCoreError> {
    if value.version != Some(VERSION) {
        return Err(ClientCoreError::Persist(
            "legacy sync store requires explicit trusted offline migration".into(),
        ));
    }
    crate::sync_limits::validate_cursor(&value.cursor)?;
    crate::sync_limits::validate_blobs(&value.blobs)?;
    let supplied = value
        .integrity
        .as_deref()
        .and_then(|tag| blake3::Hash::from_hex(tag).ok())
        .ok_or_else(|| ClientCoreError::Persist("invalid sync store integrity tag".into()))?;
    if supplied != digest(key, value)? {
        return Err(ClientCoreError::Persist(
            "sync store integrity check failed".into(),
        ));
    }
    Ok(())
}
