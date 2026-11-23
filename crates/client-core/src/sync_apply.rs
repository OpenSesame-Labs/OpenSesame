//! Atomic authenticated application of remote sync blobs.

use std::collections::{BTreeMap, HashMap};

use crate::{sync_auth, sync_limits, ClientCoreError, DeviceKey, SyncBlob, SyncStore};

impl SyncStore {
    fn reject_equal_epoch_conflict(
        existing: &[u8],
        incoming: &[u8],
    ) -> Result<(), ClientCoreError> {
        if existing != incoming {
            return Err(ClientCoreError::InvalidBlob(
                "conflicting sync versions at equal epoch",
            ));
        }
        Ok(())
    }

    fn scan_equal_epoch_conflicts(
        entries: &BTreeMap<String, (u64, Vec<u8>)>,
        blobs: &[SyncBlob],
    ) -> Result<(), ClientCoreError> {
        for b in blobs {
            let Some((ep, existing_ct)) = entries.get(&b.id) else {
                continue;
            };
            if *ep != b.epoch {
                continue;
            }
            Self::reject_equal_epoch_conflict(existing_ct, &b.ciphertext)?;
        }
        let mut batch: HashMap<(String, u64), &Vec<u8>> = HashMap::new();
        for b in blobs {
            let key = (b.id.clone(), b.epoch);
            if let Some(existing) = batch.get(&key) {
                Self::reject_equal_epoch_conflict(existing, &b.ciphertext)?;
            } else {
                batch.insert(key, &b.ciphertext);
            }
        }
        Ok(())
    }

    pub(crate) fn apply_authenticated(
        &mut self,
        key: &DeviceKey,
        blobs: &[SyncBlob],
    ) -> Result<usize, ClientCoreError> {
        sync_limits::validate_cursor(&self.cursor)?;
        sync_limits::validate_capacity(&self.entries, blobs)?;
        let guard = self.checked_key(key)?;
        for blob in blobs {
            sync_auth::verify_blob(key, blob)?;
        }
        Self::scan_equal_epoch_conflicts(&self.entries, blobs)?;
        if !blobs.is_empty() {
            self.remember_key(guard)?;
        }
        let mut applied = 0;
        for b in blobs {
            let replace = match self.entries.get(&b.id) {
                None => true,
                Some((ep, _)) if *ep < b.epoch => true,
                Some((ep, _)) if *ep == b.epoch => false,
                Some((_, _)) => false,
            };
            if replace {
                self.entries
                    .insert(b.id.clone(), (b.epoch, b.ciphertext.clone()));
                self.cursor.epoch = self.cursor.epoch.max(b.epoch);
                applied += 1;
            }
        }
        Ok(applied)
    }
}
