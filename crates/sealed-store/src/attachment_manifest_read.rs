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
        if let Some(local) = self.attachment_revision(name)? {
            Self::ensure_attachment_sidecar_matches_witness(local, state.revision)?;
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
        if let Some(local) = self.attachment_revision(name)? {
            Self::ensure_attachment_sidecar_matches_witness(local, state.revision)?;
            return self.open_manifest_at_witness(name, key);
        }
        drop(lock);
        // The revision map is shared across attachments; serialize backfill with the
        // same exclusive lock attachment GC and listing use.
        let _lock = crate::store_lock::StoreLock::key_file_edit(&self.path)?;
        let state = self.attachment_entry_state(name, key)?;
        if state.deleted {
            return Err(StoreError::NotFound(name.into()));
        }
        if let Some(local) = self.attachment_revision(name)? {
            Self::ensure_attachment_sidecar_matches_witness(local, state.revision)?;
        }
        let result = self.open_manifest_at_witness(name, key)?;
        if self.attachment_revision(name)?.is_none() {
            self.record_attachment_revision(name, state.revision)?;
        }
        Ok(result)
    }

    fn ensure_attachment_sidecar_matches_witness(
        local: u64,
        witnessed: u64,
    ) -> Result<(), StoreError> {
        if local == witnessed {
            return Ok(());
        }
        let msg = if local < witnessed {
            "attachment revision sidecar is behind outside witness"
        } else {
            "attachment revision sidecar is ahead of outside witness"
        };
        Err(StoreError::Crypto(msg.into()))
    }
}
