//! Explicit migration of entries whose old ciphertext did not bind a name.

use zeroize::Zeroizing;

use super::{
    auto_commit, confined_atomic_write, confined_read, ItemDataKey, StoreError, StoreLock,
    StoreRoot, COMMIT_REBIND,
};
use crate::envelope::{open_legacy_for_trusted_migration, seal_osseal};

impl StoreRoot {
    /// Rebind an old entry to `name` after the owner has independently
    /// verified that the source file belongs there and is the intended version.
    /// The legacy ciphertext itself cannot prove either fact. This operation
    /// takes the exclusive store lock and refuses non-legacy ciphertext.
    ///
    /// # Errors
    ///
    /// Returns an error for untrusted format, invalid path or key, exhausted
    /// revision, concurrent writers, or failed storage operations.
    pub fn migrate_legacy_entry_trusting_name(
        &self,
        name: &str,
        key: &ItemDataKey,
    ) -> Result<(), StoreError> {
        let name = name.trim();
        let _lock = StoreLock::for_legacy_migration(&self.path, name, key)?;
        let rel = Self::entry_relative(name, "osseal")?;
        let original = confined_read(&self.path, &rel)?;
        let plaintext = Zeroizing::new(open_legacy_for_trusted_migration(&original, key)?);
        let revision = self.next_trusted_revision(
            name,
            &self.path.join(&rel),
            key,
            0,
            Some(&plaintext),
        )?;
        let sealed = seal_osseal(&plaintext, key, name, revision)?;
        // If interrupted between these writes, the old unbound file still
        // requires another explicitly trusted migration; it never opens
        // through the ordinary reader.
        confined_atomic_write(&self.path, &rel, &sealed)?;
        auto_commit(&self.path, COMMIT_REBIND)?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "store_legacy_tests.rs"]
mod tests;
