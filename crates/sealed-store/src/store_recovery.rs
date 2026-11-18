//! Deliberate recovery of an owner-verified on-disk native entry.

use zeroize::Zeroizing;

use super::{
    auto_commit, confined_atomic_write, confined_read, open_osseal, seal_osseal, ItemDataKey,
    StoreError, StoreLock, StoreRoot, COMMIT_RESTORE,
};

impl StoreRoot {
    /// Reseal the currently stored native entry after its owner independently
    /// decides to trust that ciphertext's version. This is useful after an
    /// interrupted removal in a store without Git history. Authentication
    /// proves the ciphertext's name and contents, but cannot prove freshness:
    /// it may be an old, replayed version. Ordinary reads never call this.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid paths, a concurrent mutation, the wrong
    /// key, invalid ciphertext, exhausted revisions, or failed persistence.
    pub fn recover_entry_trusting_ciphertext(
        &self,
        name: &str,
        key: &ItemDataKey,
    ) -> Result<(), StoreError> {
        let _lock = StoreLock::for_sealing(&self.path, name, key)?;
        let rel = Self::entry_relative(name, "osseal")?;
        let opened = open_osseal(&confined_read(&self.path, &rel)?, key, name, None)?;
        let plaintext = Zeroizing::new(opened.plaintext);
        let current = self.revision(name)?.unwrap_or(0).max(opened.revision);
        let next = current
            .checked_add(1)
            .ok_or_else(|| StoreError::Crypto("entry revision exhausted".into()))?;
        let sealed = seal_osseal(&plaintext, key, name, next)?;
        // If interrupted, the previous ciphertext remains whole and this
        // explicit recovery can be repeated; no rollback is performed.
        self.record_revision(name, next)?;
        confined_atomic_write(&self.path, &rel, &sealed)?;
        auto_commit(&self.path, COMMIT_RESTORE)?;
        Ok(())
    }
}
