use crate::{ItemDataKey, StoreError, StoreRoot};

impl StoreRoot {
    pub(super) fn allow_foreign_format_fallback(
        &self,
        name: &str,
        key: &ItemDataKey,
    ) -> Result<(), StoreError> {
        match self.entry_witness(name, key) {
            Err(StoreError::Crypto(ref msg)) if msg.contains("missing anti-rollback state") => {
                Ok(())
            }
            Err(error) => Err(error),
            Ok(witness) if witness.deleted => Err(StoreError::NotFound(name.into())),
            Ok(_) => Err(StoreError::Crypto(format!(
                "witnessed native entry {name} has no .osseal; restore it instead of using foreign-format fallback"
            ))),
        }
    }
}
