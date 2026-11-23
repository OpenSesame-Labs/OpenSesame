//! Explicit migration from an independently verified version-one checkpoint.

use super::{
    attachments, commit_marker::CommitMarker, commitment_unbound, normalize, SLOT_ONE, SLOT_TWO,
};
use crate::{ItemDataKey, StoreError, StoreRoot};

impl StoreRoot {
    pub(super) fn migrate_existing_witness(
        &self,
        key: &ItemDataKey,
        store_id: &str,
    ) -> Result<(), StoreError> {
        let inside = self.read_store_id()?;
        if inside.as_deref().is_some_and(|id| id != store_id) {
            return Err(StoreError::Crypto(
                "store identity does not match its outside rollback anchor".into(),
            ));
        }
        if let Some(marker) = self.read_commit_marker(store_id, key)? {
            return self.migrate_committed_witness(
                key,
                store_id,
                marker.is_rotation_pending(),
                inside.is_none(),
            );
        }
        self.migrate_markerless_witness(key, store_id)?;
        // Complete an identity write interrupted after publishing the marker.
        self.current_witness(key)?;
        Ok(())
    }

    /// Continue a migration whose commit marker is already published.
    fn migrate_committed_witness(
        &self,
        key: &ItemDataKey,
        store_id: &str,
        rotation_pending: bool,
        inside_missing: bool,
    ) -> Result<(), StoreError> {
        if rotation_pending {
            // This entry point is an explicit trust ceremony and holds the
            // current-key lock; normal reads cannot clear the fence.
            self.recover_pending_rotation(store_id, key)?;
            self.current_witness(key)?;
            return Ok(());
        }
        if inside_missing {
            // Authenticate the committed state before repairing either
            // identity slot. Publish both slots before the in-store ID so
            // another interruption still follows this recovery path.
            self.load_witness(store_id, key)?.ok_or_else(|| {
                StoreError::Crypto("committed rollback witness is missing".into())
            })?;
            self.write_outside_identity(key, store_id)?;
        }
        let (_, witness) = self.current_witness(key)?;
        if !attachments::marked(&witness) {
            return self.upgrade_attachment_anchor(key);
        }
        // The first anchor was published, but writing its in-store identity
        // stopped. current_witness has now completed that final step.
        if inside_missing {
            Ok(())
        } else {
            Err(StoreError::Other("rollback anchor already exists".into()))
        }
    }

    fn migrate_markerless_witness(
        &self,
        key: &ItemDataKey,
        store_id: &str,
    ) -> Result<(), StoreError> {
        let (root, directory) = self.witness_directory(store_id)?;
        let mut candidates = Vec::new();
        for slot in [SLOT_ONE, SLOT_TWO] {
            // Only an absent slot is empty. A slot that exists but cannot be
            // read must abort the migration instead of silently selecting a
            // candidate from a lower epoch.
            if let Some(witness) =
                self.read_witness_slot(&root, &directory.join(slot), store_id, key)?
            {
                candidates.push(witness);
            }
        }
        let legacy = candidates
            .iter()
            .filter(|candidate| candidate.version == 1)
            .max_by_key(|candidate| candidate.epoch)
            .ok_or_else(|| {
                StoreError::Crypto(
                    "rollback commit marker is missing; restore the current outside checkpoint"
                        .into(),
                )
            })?;
        let mut expected = legacy.clone();
        expected.entries = normalize::entries(expected.entries)?;
        if !attachments::marked(&expected) {
            self.anchor_attachments(&mut expected, key)?;
        }
        for (name, entry) in &mut expected.entries {
            if name.starts_with(".attachments/")
                || entry.deleted
                || !commitment_unbound(&entry.commitment)
            {
                continue;
            }
            *entry = self.migration_entry_witness_v1_upgrade(name, entry.revision, key)?;
        }
        expected.version = 2;
        expected.epoch = expected
            .epoch
            .checked_add(1)
            .ok_or_else(|| StoreError::Crypto("rollback witness epoch exhausted".into()))?;

        if let Some(prepared) = candidates.iter().find(|candidate| candidate.version == 2) {
            // A previous migration can have persisted the exact new witness
            // before publishing its marker. Never replace a different v2 state
            // or silently rebuild a marker for an already migrated checkpoint.
            if !CommitMarker::for_witness(&expected)?.matches(prepared)? {
                return Err(StoreError::Crypto(
                    "rollback migration state differs from its prepared witness; restore the outside checkpoint".into(),
                ));
            }
            self.write_commit_marker(store_id, key, prepared)
        } else {
            self.write_witness_from_legacy(store_id, key, legacy, &expected)
        }
    }
}
