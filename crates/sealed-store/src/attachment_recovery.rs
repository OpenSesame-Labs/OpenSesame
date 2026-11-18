//! Deliberate recovery of an owner-verified attachment manifest.

use zeroize::Zeroizing;

use super::*;

impl StoreRoot {
    /// Reseal the current manifest after its owner independently decides to
    /// trust its version. Authentication proves the attachment name and bytes,
    /// not their freshness. This can recover an interrupted removal without Git;
    /// ordinary attachment reads never bypass their local revision check.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid paths, a concurrent mutation, wrong key,
    /// invalid manifest, exhausted revisions, or failed persistence.
    pub fn recover_attachment_trusting_ciphertext(
        &self,
        name: &str,
        key: &ItemDataKey,
    ) -> Result<(), StoreError> {
        let _lock = crate::store_lock::StoreLock::for_sealing(&self.path, name, key)?;
        let rel = attach_relative(name)?;
        let blob = confined_read(&self.path, &rel)?;
        let opened = open_osseal_in(COLLECTION_ATTACHMENTS, &blob, key, name, None)?;
        let plaintext = Zeroizing::new(opened.plaintext);
        parse_attachment_manifest(&plaintext)?;
        let current = self
            .attachment_revision(name)?
            .unwrap_or(0)
            .max(opened.revision);
        let next = current
            .checked_add(1)
            .ok_or_else(|| StoreError::Crypto("attachment revision exhausted".into()))?;
        let sealed = seal_osseal_in(COLLECTION_ATTACHMENTS, &plaintext, key, name, next)?;
        self.record_attachment_revision(name, next)?;
        confined_atomic_write(&self.path, &rel, &sealed)?;
        auto_commit(&self.path, crate::store::COMMIT_RESTORE)?;
        Ok(())
    }
}

pub(super) fn parse_attachment_manifest(
    plaintext: &[u8],
) -> Result<AttachmentManifest, StoreError> {
    let manifest: AttachmentManifest = serde_json::from_slice(plaintext)
        .map_err(|e| StoreError::Crypto(format!("invalid manifest: {e}")))?;
    if manifest.format != MANIFEST_FORMAT {
        return Err(StoreError::Crypto(format!(
            "unsupported manifest format {}",
            manifest.format
        )));
    }
    let chunk_count = usize::try_from(manifest.chunk_count)
        .map_err(|_| StoreError::Crypto("manifest chunk count exceeds platform capacity".into()))?;
    if manifest.chunks.len() != chunk_count {
        return Err(StoreError::Crypto("manifest chunk count mismatch".into()));
    }
    if manifest.filename.len() > MAX_FILENAME_BYTES {
        return Err(StoreError::Crypto("manifest filename too long".into()));
    }
    let declared: u64 = manifest.chunks.iter().map(|c| c.pt_bytes).sum();
    if declared != manifest.total_bytes {
        return Err(StoreError::Crypto("manifest size mismatch".into()));
    }
    Ok(manifest)
}
