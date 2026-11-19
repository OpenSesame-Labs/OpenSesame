//! Preserve both root-key recovery paths until the rotation commits.

use super::{WitnessRekey, COLLECTION, IDENTITY_ONE, IDENTITY_TWO, SLOT_ONE, SLOT_TWO};
use crate::envelope::seal_osseal_in;
use crate::{ItemDataKey, StoreError, StoreRoot};

impl StoreRoot {
    pub(crate) fn prepare_witness_rekey(
        &self,
        old_key: &ItemDataKey,
    ) -> Result<WitnessRekey, StoreError> {
        let (store_id, witness) = self.current_witness(old_key)?;
        let prepared = WitnessRekey { store_id, witness };
        // Heal redundancy first: slot two remains usable with the old key
        // while slot one and the separate new-key marker are prepared.
        self.write_rekeyed_witness(&prepared, old_key)?;
        self.finish_rekeyed_witness(&prepared, old_key)?;
        Ok(prepared)
    }

    fn seal_rekeyed_witness(
        prepared: &WitnessRekey,
        key: &ItemDataKey,
    ) -> Result<Vec<u8>, StoreError> {
        let plaintext = serde_json::to_vec(&prepared.witness)
            .map_err(|error| StoreError::Crypto(format!("rollback witness: {error}")))?;
        seal_osseal_in(
            COLLECTION,
            &plaintext,
            key,
            &prepared.store_id,
            prepared.witness.epoch,
        )
    }

    pub(crate) fn write_rekeyed_witness(
        &self,
        prepared: &WitnessRekey,
        key: &ItemDataKey,
    ) -> Result<(), StoreError> {
        let sealed = Self::seal_rekeyed_witness(prepared, key)?;
        self.write_outside_identity_slot(key, &prepared.store_id, IDENTITY_ONE)?;
        self.write_witness_slot(&prepared.store_id, SLOT_ONE, &sealed)?;
        self.write_commit_marker(&prepared.store_id, key, &prepared.witness)
    }

    pub(crate) fn mark_rotation_pending(
        &self,
        prepared: &WitnessRekey,
        key: &ItemDataKey,
    ) -> Result<(), StoreError> {
        self.mark_commit_rotation_pending(&prepared.store_id, key, &prepared.witness)
    }

    pub(crate) fn finish_rekeyed_witness(
        &self,
        prepared: &WitnessRekey,
        key: &ItemDataKey,
    ) -> Result<(), StoreError> {
        let sealed = Self::seal_rekeyed_witness(prepared, key)?;
        self.write_outside_identity_slot(key, &prepared.store_id, IDENTITY_TWO)?;
        self.write_witness_slot(&prepared.store_id, SLOT_TWO, &sealed)
    }

    #[cfg(test)]
    pub(crate) fn write_first_rekeyed_witness_slot(
        &self,
        prepared: &WitnessRekey,
        key: &ItemDataKey,
    ) -> Result<(), StoreError> {
        self.write_rekeyed_witness(prepared, key)
    }
}
