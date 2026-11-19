//! Explicit recovery must advance an existing outside checkpoint.
use std::path::Path;

use crate::{StoreError, StoreRoot};
use opensesame_human_vault::ItemDataKey;

impl StoreRoot {
    /// An operator can repair a verified pre-anchor checkout before the
    /// separate explicit anchoring ceremony. A previously anchored store
    /// instead requires its existing outside checkpoint.
    pub(crate) fn next_trusted_revision(
        &self,
        name: &str,
        path: &Path,
        key: &ItemDataKey,
        minimum: u64,
    ) -> Result<u64, StoreError> {
        if self.read_store_id()?.is_some() || self.read_outside_identity(key)?.is_some() {
            return self.next_entry_revision_after(name, path, key, minimum);
        }
        let next = self
            .revision(name)?
            .unwrap_or(0)
            .max(minimum)
            .checked_add(1)
            .ok_or_else(|| StoreError::Crypto("entry revision exhausted".into()))?;
        self.record_revision(name, next)?;
        Ok(next)
    }
}
