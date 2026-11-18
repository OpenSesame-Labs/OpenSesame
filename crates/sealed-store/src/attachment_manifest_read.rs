//! Authenticate an attachment manifest before committing its local revision.
//!
//! `open_manifest` in the parent module is reserved for root rotation, which
//! already holds the exclusive store lock and stages changes separately.

use super::{attach_relative, parse_attachment_manifest, AttachmentManifest};
use crate::envelope::{open_osseal_in, COLLECTION_ATTACHMENTS};
use crate::path::confined_read;
use crate::{ItemDataKey, StoreError, StoreRoot};

impl StoreRoot {
    fn read_manifest_at_revision(
        &self,
        name: &str,
        key: &ItemDataKey,
        expected: Option<u64>,
    ) -> Result<(AttachmentManifest, u64), StoreError> {
        let rel = attach_relative(name)?;
        if !self.path.join(&rel).exists() {
            return Err(StoreError::NotFound(name.into()));
        }
        let blob = confined_read(&self.path, &rel)?;
        let opened = open_osseal_in(COLLECTION_ATTACHMENTS, &blob, key, name, expected)?;
        Ok((
            parse_attachment_manifest(&opened.plaintext)?,
            opened.revision,
        ))
    }

    /// Caller already holds the store's exclusive lock. The initial
    /// observation is recorded only after authenticating and parsing the
    /// manifest, and before returning any of its contents.
    pub(super) fn open_manifest_locked(
        &self,
        name: &str,
        key: &ItemDataKey,
    ) -> Result<AttachmentManifest, StoreError> {
        let expected = self.attachment_revision(name)?;
        let (manifest, observed) = self.read_manifest_at_revision(name, key, expected)?;
        if expected.is_none() {
            self.record_attachment_revision(name, observed)?;
        }
        Ok(manifest)
    }

    pub(super) fn open_manifest_for_read(
        &self,
        name: &str,
        key: &ItemDataKey,
    ) -> Result<AttachmentManifest, StoreError> {
        // A shared lock keeps a writer from advancing the map between the
        // revision check and the manifest read, while permitting other readers.
        let lock = crate::store_lock::StoreLock::shared(&self.path)?;
        if let Some(expected) = self.attachment_revision(name)? {
            return self
                .read_manifest_at_revision(name, key, Some(expected))
                .map(|(manifest, _)| manifest);
        }
        drop(lock);
        // A fresh clone has no local counter. Recheck under an exclusive lock
        // before recording the authenticated observation: another reader or
        // writer may have initialized it in the meantime.
        let _lock = crate::store_lock::StoreLock::key_file_edit(&self.path)?;
        self.open_manifest_locked(name, key)
    }
}
