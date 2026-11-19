//! `OpenSesame` **client-core sdk** — local E2EE + sync cursors (ADR 0017).
//!
//! WIT: `spec/wit/client/world.wit`. Server must only ever store ciphertext blobs.
//! Persist sealed blobs only (native path / JSON); never plaintext on disk.

use blake3::Hasher;
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use thiserror::Error;
use zeroize::Zeroizing;
use zeroize::{Zeroize, ZeroizeOnDrop};

pub use opensesame_core as core;
pub use opensesame_human_vault as human_vault;

#[cfg(feature = "wasm-bindgen")]
pub mod wasm;

mod legacy_migration;
mod persist_auth;
pub mod snapshot;
mod sync_apply;
mod sync_auth;
#[cfg(not(target_arch = "wasm32"))]
mod sync_files;
mod sync_limits;

pub use sync_auth::{
    open_sync_blob, LEGACY_MIGRATION_CIPHERTEXT_MAX, MAX_SYNC_CIPHERTEXT_BYTES, MAX_SYNC_ID_BYTES,
};
pub use sync_limits::{
    MAX_SYNC_BLOBS, MAX_SYNC_DEVICE_ID_BYTES, MAX_SYNC_JSON_BYTES, MAX_SYNC_PROJECT_ID_BYTES,
    MAX_SYNC_TOTAL_BYTES,
};

pub use snapshot::{
    assert_ciphertext_only_json, refuse_deployment_seal_as_wrap_key, CiphertextSyncSnapshot,
    SNAPSHOT_FORMAT, SNAPSHOT_VERSION,
};

pub mod wit_contract {
    pub const PACKAGE: &str = "opensesame:client@1.0.0";
}

#[derive(Debug, Error)]
pub enum ClientCoreError {
    #[error("aead failure")]
    Aead,
    #[error("sync conflict: remote epoch {remote} <= local {local}")]
    StaleEpoch { local: u64, remote: u64 },
    #[error("missing device key")]
    MissingKey,
    #[error("sync store key does not match")]
    WrongKey,
    #[error("sync epoch exhausted")]
    EpochExhausted,
    #[error("invalid sync blob: {0}")]
    InvalidBlob(&'static str),
    #[error("persist io: {0}")]
    Persist(String),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SyncCursor {
    pub device_id: String,
    pub epoch: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SyncBlob {
    pub id: String,
    pub epoch: u64,
    /// Opaque ciphertext — never log or decode on server.
    pub ciphertext: Vec<u8>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedStore {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    version: Option<u32>,
    #[serde(deserialize_with = "sync_limits::deserialize_cursor")]
    cursor: SyncCursor,
    /// Sealed entries only.
    #[serde(deserialize_with = "sync_limits::deserialize_blobs")]
    blobs: Vec<SyncBlob>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sync_limits::deserialize_integrity"
    )]
    integrity: Option<String>,
}

#[derive(Zeroize, ZeroizeOnDrop)]
pub struct DeviceKey {
    key: [u8; 32],
}

impl DeviceKey {
    #[must_use]
    pub fn generate() -> Self {
        let mut key = [0u8; 32];
        rand::rng().fill_bytes(&mut key);
        Self { key }
    }

    #[must_use]
    pub fn from_bytes(key: [u8; 32]) -> Self {
        Self { key }
    }

    #[must_use]
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.key
    }
}

/// Seal plaintext with XChaCha20-Poly1305; AAD binds blob id.
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub(crate) fn seal_with_nonce(
    key: &DeviceKey,
    plaintext: &[u8],
    aad: &[u8],
    nonce_bytes: [u8; 24],
) -> Result<Vec<u8>, ClientCoreError> {
    let cipher = XChaCha20Poly1305::new_from_slice(&key.key).map_err(|_| ClientCoreError::Aead)?;
    let nonce: &XNonce = (&nonce_bytes).into();
    let mut out = nonce_bytes.to_vec();
    let ct = cipher
        .encrypt(
            nonce,
            chacha20poly1305::aead::Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| ClientCoreError::Aead)?;
    out.extend(ct);
    Ok(out)
}

pub fn seal(key: &DeviceKey, plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, ClientCoreError> {
    let mut nonce_bytes = [0u8; 24];
    rand::rng().fill_bytes(&mut nonce_bytes);
    seal_with_nonce(key, plaintext, aad, nonce_bytes)
}

///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn open(key: &DeviceKey, sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>, ClientCoreError> {
    if sealed.len() < 24 {
        return Err(ClientCoreError::Aead);
    }
    let (nonce_bytes, ct) = sealed.split_at(24);
    let cipher = XChaCha20Poly1305::new_from_slice(&key.key).map_err(|_| ClientCoreError::Aead)?;
    let nonce = <&XNonce>::try_from(nonce_bytes).map_err(|_| ClientCoreError::Aead)?;
    cipher
        .decrypt(nonce, chacha20poly1305::aead::Payload { msg: ct, aad })
        .map_err(|_| ClientCoreError::Aead)
}

/// Encrypted sync store — RAM + optional sealed-blob persistence (ciphertext only).
pub struct SyncStore {
    /// id -> (epoch, ciphertext)
    pub(crate) entries: BTreeMap<String, (u64, Vec<u8>)>,
    pub(crate) cursor: SyncCursor,
    key_guard: Option<Zeroizing<[u8; 32]>>,
}

impl SyncStore {
    pub fn new(device_id: impl Into<String>) -> Self {
        Self {
            entries: BTreeMap::new(),
            cursor: SyncCursor {
                device_id: device_id.into(),
                epoch: 0,
            },
            key_guard: None,
        }
    }

    /// Current local cursor. It can only advance through authenticated blobs.
    #[must_use]
    pub fn cursor(&self) -> &SyncCursor {
        &self.cursor
    }

    fn checked_key(&self, key: &DeviceKey) -> Result<blake3::Hash, ClientCoreError> {
        let guard = blake3::keyed_hash(key.as_bytes(), b"OpenSesame sync store key v2");
        if self
            .key_guard
            .as_ref()
            .is_some_and(|known| blake3::Hash::from(**known) != guard)
        {
            return Err(ClientCoreError::WrongKey);
        }
        Ok(guard)
    }

    fn remember_key(&mut self, guard: blake3::Hash) {
        self.key_guard = Some(Zeroizing::new(*guard.as_bytes()));
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn put_local(
        &mut self,
        key: &DeviceKey,
        id: impl Into<String>,
        plaintext: &[u8],
    ) -> Result<SyncBlob, ClientCoreError> {
        let id = id.into();
        sync_limits::validate_cursor(&self.cursor)?;
        let guard = self.checked_key(key)?;
        let epoch = self
            .cursor
            .epoch
            .checked_add(1)
            .filter(|value| *value <= i64::MAX as u64)
            .ok_or(ClientCoreError::EpochExhausted)?;
        let blob = sync_auth::seal_blob(key, id, epoch, plaintext)?;
        sync_limits::validate_capacity(&self.entries, std::slice::from_ref(&blob))?;
        self.entries
            .insert(blob.id.clone(), (epoch, blob.ciphertext.clone()));
        self.cursor.epoch = epoch;
        self.remember_key(guard);
        Ok(blob)
    }

    /// Re-seal migrated legacy plaintext with deterministic v2 envelopes so
    /// independent migrations of the same trusted export converge.
    pub(crate) fn put_local_migrated(
        &mut self,
        key: &DeviceKey,
        id: impl Into<String>,
        plaintext: &[u8],
    ) -> Result<(), ClientCoreError> {
        let id = id.into();
        let guard = self.checked_key(key)?;
        let epoch = self
            .cursor
            .epoch
            .checked_add(1)
            .filter(|value| *value <= i64::MAX as u64)
            .ok_or(ClientCoreError::EpochExhausted)?;
        let blob = sync_auth::seal_blob_deterministic(key, id.clone(), epoch, plaintext)?;
        self.entries
            .insert(id, (epoch, blob.ciphertext.clone()));
        self.cursor.epoch = epoch;
        self.remember_key(guard);
        Ok(())
    }

    /// Authenticate every remote blob before applying any of them.
    /// Higher authenticated epoch wins; equal epoch with different ciphertext is an error.
    ///
    /// # Errors
    ///
    /// Returns an error without changing the store if any blob is invalid or
    /// the key does not match the store.
    pub fn apply_remote(
        &mut self,
        key: &DeviceKey,
        blobs: &[SyncBlob],
    ) -> Result<SyncCursor, ClientCoreError> {
        self.apply_authenticated(key, blobs)?;
        Ok(self.cursor.clone())
    }

    #[must_use]
    pub fn collect_outgoing(&self, since: &SyncCursor) -> Vec<SyncBlob> {
        self.entries
            .iter()
            .filter(|(_, (ep, _))| *ep > since.epoch)
            .map(|(id, (epoch, ct))| SyncBlob {
                id: id.clone(),
                epoch: *epoch,
                ciphertext: ct.clone(),
            })
            .collect()
    }

    #[must_use]
    pub fn digest_ciphertext(ct: &[u8]) -> String {
        let mut h = Hasher::new();
        h.update(ct);
        h.finalize().to_hex().to_string()
    }

    /// Serialize sealed blobs + cursor (never plaintext).
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn to_persisted_json(&mut self, key: &DeviceKey) -> Result<String, ClientCoreError> {
        let guard = self.checked_key(key)?;
        let blobs: Vec<SyncBlob> = self
            .entries
            .iter()
            .map(|(id, (epoch, ct))| SyncBlob {
                id: id.clone(),
                epoch: *epoch,
                ciphertext: ct.clone(),
            })
            .collect();
        let mut p = PersistedStore {
            version: Some(persist_auth::VERSION),
            cursor: self.cursor.clone(),
            blobs,
            integrity: None,
        };
        p.integrity = Some(persist_auth::tag(key, &p)?);
        self.remember_key(guard);
        let json =
            serde_json::to_string(&p).map_err(|e| ClientCoreError::Persist(e.to_string()))?;
        sync_limits::check_json_size(json.len())?;
        Ok(json)
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn from_persisted_json(key: &DeviceKey, json: &str) -> Result<Self, ClientCoreError> {
        sync_limits::check_json_size(json.len())?;
        let p: PersistedStore =
            serde_json::from_str(json).map_err(|e| ClientCoreError::Persist(e.to_string()))?;
        persist_auth::verify(key, &p)?;
        let mut store = Self::new(p.cursor.device_id.clone());
        store.apply_remote(key, &p.blobs)?;
        if store.key_guard.is_none() {
            store.remember_key(blake3::keyed_hash(
                key.as_bytes(),
                b"OpenSesame sync store key v2",
            ));
        }
        if p.cursor.epoch < store.cursor.epoch || p.cursor.epoch > i64::MAX as u64 {
            return Err(ClientCoreError::Persist(
                "invalid authenticated cursor epoch".into(),
            ));
        }
        store.cursor.epoch = p.cursor.epoch;
        Ok(store)
    }
}

#[cfg(test)]
#[path = "sync_tests.rs"]
mod tests;
