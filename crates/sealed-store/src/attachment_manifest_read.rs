//! Authenticate an attachment manifest against its outside rollback witness.
use super::{attach_relative, AttachmentManifest};
use crate::{ItemDataKey, StoreError, StoreRoot};

impl StoreRoot {
    pub(super) fn open_manifest_at_witness(
        &self,
        name: &str,
        key: &ItemDataKey,
    ) -> Result<(AttachmentManifest, String), StoreError> {
        // Parsed from the single commitment-checked read.
        self.open_committed_attachment_manifest(name, key)
    }

    /// Caller already holds the store's exclusive lock.
    pub(super) fn open_manifest_locked(
        &self,
        name: &str,
        key: &ItemDataKey,
    ) -> Result<AttachmentManifest, StoreError> {
        let state = self.attachment_entry_state(name, key)?;
        if state.deleted {
            return Err(StoreError::NotFound(name.into()));
        }
        let (manifest, _) = self.open_manifest_at_witness(name, key)?;
        if self.attachment_revision(name)?.is_none() {
            self.record_attachment_revision(name, state.revision)?;
        }
        Ok(manifest)
    }

    pub(super) fn open_manifest_for_read(
        &self,
        name: &str,
        key: &ItemDataKey,
    ) -> Result<(AttachmentManifest, String), StoreError> {
        let lock = crate::store_lock::StoreLock::shared(&self.path)?;
        if !self.path.join(attach_relative(name)?).exists() {
            return Err(StoreError::NotFound(name.into()));
        }
        let state = self.attachment_entry_state(name, key)?;
        if state.deleted {
            return Err(StoreError::NotFound(name.into()));
        }
        let result = self.open_manifest_at_witness(name, key)?;
        if let Some(local) = self.attachment_revision(name)? {
            if local < state.revision {
                return Err(StoreError::Crypto(
                    "attachment revision sidecar is behind outside witness".into(),
                ));
            }
            return Ok(result);
        }
        drop(lock);
        let _lock = crate::store_lock::StoreLock::for_sealing(&self.path, name, key)?;
        let state = self.attachment_entry_state(name, key)?;
        if state.deleted {
            return Err(StoreError::NotFound(name.into()));
        }
        let result = self.open_manifest_at_witness(name, key)?;
        if self.attachment_revision(name)?.is_none() {
            self.record_attachment_revision(name, state.revision)?;
        }
        Ok(result)
    }
}
