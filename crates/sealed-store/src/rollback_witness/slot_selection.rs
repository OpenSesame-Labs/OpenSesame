//! Never replace the only copy of a committed checkpoint before its successor.

use super::{commit_marker::CommitMarker, Witness, COLLECTION, SLOT_ONE, SLOT_TWO};
use crate::envelope::seal_osseal_in;
use crate::{ItemDataKey, StoreError, StoreRoot};

fn alternating_slot(epoch: u64) -> &'static str {
    if epoch.is_multiple_of(2) {
        SLOT_TWO
    } else {
        SLOT_ONE
    }
}

impl StoreRoot {
    pub(super) fn next_witness_slot(
        &self,
        store_id: &str,
        key: &ItemDataKey,
        epoch: u64,
        legacy: Option<&Witness>,
    ) -> Result<&'static str, StoreError> {
        let marker = self.read_commit_marker(store_id, key)?;
        let (root, directory) = self.witness_directory(store_id)?;
        let one = self.read_witness_slot(&root, &directory.join(SLOT_ONE), store_id, key);
        let two = self.read_witness_slot(&root, &directory.join(SLOT_TWO), store_id, key);
        let marker = match (marker, legacy) {
            (Some(marker), _) => marker,
            (None, Some(witness)) => CommitMarker::for_witness(witness)?,
            (None, None) if matches!((&one, &two), (Ok(None), Ok(None))) => {
                return Ok(alternating_slot(epoch));
            }
            (None, None) => {
                return Err(StoreError::Crypto(
                    "rollback commit marker is missing for existing witness slots".into(),
                ));
            }
        };
        marker.require_active()?;
        let matches = |candidate: Result<Option<Witness>, StoreError>| -> Result<bool, StoreError> {
            match candidate {
                Ok(Some(witness)) => marker.matches(&witness),
                Ok(None) | Err(_) => Ok(false),
            }
        };
        match (matches(one)?, matches(two)?) {
            (true, true) => Ok(alternating_slot(epoch)),
            (true, false) => Ok(SLOT_TWO),
            (false, true) => Ok(SLOT_ONE),
            (false, false) => Err(StoreError::Crypto(
                "cannot preserve the committed rollback witness while publishing its successor"
                    .into(),
            )),
        }
    }

    fn publish_witness(
        &self,
        store_id: &str,
        key: &ItemDataKey,
        witness: &Witness,
        legacy: Option<&Witness>,
    ) -> Result<(), StoreError> {
        let slot = self.next_witness_slot(store_id, key, witness.epoch, legacy)?;
        let plaintext = serde_json::to_vec(witness)
            .map_err(|error| StoreError::Crypto(format!("rollback witness: {error}")))?;
        let sealed = seal_osseal_in(COLLECTION, &plaintext, key, store_id, witness.epoch)?;
        self.write_witness_slot(store_id, slot, &sealed)?;
        self.write_commit_marker(store_id, key, witness)
    }

    pub(super) fn write_witness(
        &self,
        store_id: &str,
        key: &ItemDataKey,
        witness: &Witness,
    ) -> Result<(), StoreError> {
        self.publish_witness(store_id, key, witness, None)
    }

    pub(super) fn write_witness_from_legacy(
        &self,
        store_id: &str,
        key: &ItemDataKey,
        legacy: &Witness,
        witness: &Witness,
    ) -> Result<(), StoreError> {
        self.publish_witness(store_id, key, witness, Some(legacy))
    }
}
