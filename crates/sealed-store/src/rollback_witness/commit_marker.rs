//! A separately published, authenticated commitment to the current witness.
//!
//! The marker and witness still require independent protection from rollback as
//! a set. A current marker prevents accepting an older surviving witness slot.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::{StoreRoot, Witness};
use crate::envelope::{open_osseal_in, seal_osseal_in};
use crate::path::{confined_read, confined_replace};
use crate::{ItemDataKey, StoreError};

const COLLECTION: &str = "rollback-witness-commit";

#[derive(Deserialize, Serialize)]
pub(super) struct CommitMarker {
    version: u8,
    epoch: u64,
    digest: String,
    #[serde(default)]
    rotation_pending: bool,
}

impl CommitMarker {
    pub(super) fn for_witness(witness: &Witness) -> Result<Self, StoreError> {
        let plaintext = serde_json::to_vec(witness)
            .map_err(|error| StoreError::Crypto(format!("rollback witness: {error}")))?;
        Ok(Self {
            version: 1,
            epoch: witness.epoch,
            digest: blake3::hash(&plaintext).to_hex().to_string(),
            rotation_pending: false,
        })
    }

    pub(super) fn matches(&self, witness: &Witness) -> Result<bool, StoreError> {
        let expected = Self::for_witness(witness)?;
        Ok(self.epoch == expected.epoch && self.digest == expected.digest)
    }

    pub(super) fn is_rotation_pending(&self) -> bool {
        self.rotation_pending
    }

    pub(super) fn require_active(&self) -> Result<(), StoreError> {
        if self.rotation_pending {
            return Err(StoreError::Crypto(
                "this root key has a pending rotation; independently verify recovery before re-anchoring".into(),
            ));
        }
        Ok(())
    }
}

impl StoreRoot {
    pub(super) fn commit_marker_relative(store_id: &str, key: &ItemDataKey) -> PathBuf {
        // A key-specific name keeps both markers available while the root key
        // and the two witness slots move across a rotation's commit boundary.
        let mut hasher = blake3::Hasher::new_keyed(&key.0);
        hasher.update(b"opensesame/rollback-witness/commit-marker/v1\0");
        hasher.update(store_id.as_bytes());
        PathBuf::from(store_id)
            .join("committed")
            .join(format!("{}.marker", hasher.finalize().to_hex()))
    }

    pub(super) fn read_commit_marker(
        &self,
        store_id: &str,
        key: &ItemDataKey,
    ) -> Result<Option<CommitMarker>, StoreError> {
        let (root, _) = self.witness_directory(store_id)?;
        let relative = Self::commit_marker_relative(store_id, key);
        if !root.join(&relative).exists() {
            return Ok(None);
        }
        let opened = open_osseal_in(
            COLLECTION,
            &confined_read(&root, &relative)?,
            key,
            store_id,
            None,
        )?;
        let marker: CommitMarker = serde_json::from_slice(&opened.plaintext).map_err(|error| {
            StoreError::Crypto(format!("invalid witness commit marker: {error}"))
        })?;
        if marker.version != 1 || marker.epoch == 0 || marker.epoch != opened.revision {
            return Err(StoreError::Crypto("invalid witness commit marker".into()));
        }
        Ok(Some(marker))
    }

    pub(super) fn write_commit_marker(
        &self,
        store_id: &str,
        key: &ItemDataKey,
        witness: &Witness,
    ) -> Result<(), StoreError> {
        let marker = CommitMarker::for_witness(witness)?;
        if let Some(current) = self.read_commit_marker(store_id, key)? {
            current.require_active()?;
            if marker.epoch < current.epoch {
                return Err(StoreError::Crypto(
                    "cannot replace a committed rollback marker with older or different state"
                        .into(),
                ));
            }
            if marker.epoch == current.epoch
                && !current.matches(witness)?
                && self
                    .load_witness(store_id, key)?
                    .is_none_or(|baseline| {
                        !super::attachments_rotation::rotation_prepared_witness_allows_pending(
                            &baseline, witness,
                        )
                    })
            {
                return Err(StoreError::Crypto(
                    "cannot replace a committed rollback marker with older or different state"
                        .into(),
                ));
            }
        }
        self.persist_commit_marker(store_id, key, &marker)
    }

    fn persist_commit_marker(
        &self,
        store_id: &str,
        key: &ItemDataKey,
        marker: &CommitMarker,
    ) -> Result<(), StoreError> {
        let plaintext = serde_json::to_vec(&marker)
            .map_err(|error| StoreError::Crypto(format!("witness commit marker: {error}")))?;
        let sealed = seal_osseal_in(COLLECTION, &plaintext, key, store_id, marker.epoch)?;
        let (root, _) = self.witness_directory(store_id)?;
        confined_replace(&root, &Self::commit_marker_relative(store_id, key), &sealed)
    }

    pub(super) fn mark_commit_rotation_pending(
        &self,
        store_id: &str,
        key: &ItemDataKey,
        expected: &Witness,
    ) -> Result<(), StoreError> {
        let mut marker = self.read_commit_marker(store_id, key)?.ok_or_else(|| {
            StoreError::Crypto("rollback commit marker is missing during rotation".into())
        })?;
        marker.require_active()?;
        let current = self.load_witness(store_id, key)?.ok_or_else(|| {
            StoreError::Crypto("rollback witness is missing during rotation".into())
        })?;
        if !marker.matches(&current)? {
            return Err(StoreError::Crypto(
                "rollback witness changed during rotation".into(),
            ));
        }
        if !marker.matches(expected)?
            && !super::attachments_rotation::rotation_prepared_witness_allows_pending(
                &current, expected,
            )
        {
            return Err(StoreError::Crypto(
                "rollback witness changed during rotation".into(),
            ));
        }
        marker.rotation_pending = true;
        self.persist_commit_marker(store_id, key, &marker)
    }

    /// Called only by the explicitly trusted re-anchor ceremony after the
    /// operator has independently resolved the rotation staging and key state.
    pub(super) fn recover_pending_rotation(
        &self,
        store_id: &str,
        key: &ItemDataKey,
    ) -> Result<(), StoreError> {
        let mut marker = self
            .read_commit_marker(store_id, key)?
            .ok_or_else(|| StoreError::Crypto("pending rotation marker is missing".into()))?;
        if !marker.rotation_pending {
            return Err(StoreError::Crypto("rotation marker is not pending".into()));
        }
        let (root, directory) = self.witness_directory(store_id)?;
        let candidates = [super::SLOT_ONE, super::SLOT_TWO]
            .into_iter()
            .filter_map(|slot| {
                self.read_witness_slot(&root, &directory.join(slot), store_id, key)
                    .ok()
                    .flatten()
            });
        let mut found = false;
        for witness in candidates {
            if witness.version == 2 && marker.matches(&witness)? {
                found = true;
                break;
            }
        }
        if !found {
            return Err(StoreError::Crypto(
                "pending rotation witness is missing".into(),
            ));
        }
        self.write_outside_identity(key, store_id)?;
        marker.rotation_pending = false;
        self.persist_commit_marker(store_id, key, &marker)
    }
}
