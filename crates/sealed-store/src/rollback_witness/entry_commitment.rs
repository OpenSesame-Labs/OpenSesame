//! Entry rollback witness binds to exact entry plaintext (not just revision).

use std::path::Path;

use super::{commitment_unbound, entry_plaintext_commitment, EntryWitness};
use crate::envelope::open_osseal_for_path;
use crate::path::confined_read;
use crate::{ItemDataKey, StoreError, StoreRoot};

pub(super) fn entry_matches(state: &EntryWitness, plaintext: &[u8]) -> bool {
    !commitment_unbound(&state.commitment)
        && state.commitment == entry_plaintext_commitment(plaintext)
}

impl StoreRoot {
    pub(crate) fn verify_entry_plaintext_opened(
        state: &EntryWitness,
        plaintext: &[u8],
    ) -> Result<(), StoreError> {
        if state.deleted || commitment_unbound(&state.commitment) {
            return Ok(());
        }
        if !entry_matches(state, plaintext) {
            return Err(StoreError::Crypto(
                "entry plaintext does not match its rollback witness".into(),
            ));
        }
        Ok(())
    }

    pub(crate) fn verify_entry_plaintext(
        &self,
        name: &str,
        key: &ItemDataKey,
        state: &EntryWitness,
    ) -> Result<(), StoreError> {
        if state.deleted || commitment_unbound(&state.commitment) {
            return Ok(());
        }
        let relative = Self::entry_relative(name, "osseal")?;
        let opened = open_osseal_for_path(
            &confined_read(&self.path, &relative)?,
            key,
            name,
            Some(state.revision),
        )?;
        Self::verify_entry_plaintext_opened(state, &opened.plaintext)
    }

    fn open_entry_plaintext_at_revision(
        &self,
        name: &str,
        key: &ItemDataKey,
        revision: u64,
    ) -> Result<Vec<u8>, StoreError> {
        let relative = Self::entry_relative(name, "osseal")?;
        let opened = open_osseal_for_path(
            &confined_read(&self.path, &relative)?,
            key,
            name,
            Some(revision),
        )?;
        Ok(opened.plaintext)
    }

    pub(crate) fn next_entry_revision_after(
        &self,
        name: &str,
        path: &Path,
        key: &ItemDataKey,
        minimum: u64,
        plaintext: Option<&[u8]>,
        trust_plaintext: bool,
    ) -> Result<u64, StoreError> {
        let (store_id, mut witness) = self.current_witness(key)?;
        let identity = crate::store::revision_identity(name)?;
        if path.exists() && !witness.entries.contains_key(&identity) {
            return Err(StoreError::Crypto(format!(
                "missing anti-rollback state for {name}; refusing ciphertext bootstrap"
            )));
        }
        if !trust_plaintext {
            if let Some(state) = witness.entries.get(&identity).copied() {
                if !state.deleted && path.exists() {
                    match self.open_entry_plaintext_at_revision(name, key, state.revision) {
                        Ok(bytes)
                            if !commitment_unbound(&state.commitment)
                                && !entry_matches(&state, &bytes) =>
                        {
                            return Err(StoreError::Crypto(
                                "entry plaintext does not match its rollback witness".into(),
                            ));
                        }
                        Ok(_) => {}
                        Err(error) => return Err(error),
                    }
                }
            }
        }
        let commitment = plaintext
            .map(entry_plaintext_commitment)
            .unwrap_or([0; 32]);
        let current = witness
            .entries
            .get(&identity)
            .map_or(0, |entry| entry.revision)
            .max(self.revision(name)?.unwrap_or(0))
            .max(minimum);
        let next = current
            .checked_add(1)
            .ok_or_else(|| StoreError::Crypto("entry revision exhausted".into()))?;
        witness.entries.insert(
            identity,
            EntryWitness {
                revision: next,
                deleted: false,
                commitment,
            },
        );
        witness.epoch = witness
            .epoch
            .checked_add(1)
            .ok_or_else(|| StoreError::Crypto("rollback witness epoch exhausted".into()))?;
        self.write_witness(&store_id, key, &witness)?;
        self.record_revision(name, next)?;
        Ok(next)
    }
}