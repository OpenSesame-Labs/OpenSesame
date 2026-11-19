//! Authenticated high-water state held outside the Git/backup store root.

use std::collections::BTreeMap;
use std::path::Path;

use opensesame_human_vault::ItemDataKey;
use rand::Rng;
use serde::{Deserialize, Serialize};

use crate::envelope::{open_legacy_for_trusted_migration, open_osseal_for_path};
use crate::path::{confined_read, confined_replace};
use crate::store_lock::StoreLock;
use crate::{StoreError, StoreRoot};

const STORE_ID_FILE: &str = ".opensesame-store-id";
const COLLECTION: &str = "rollback-witness";
const IDENTITY_COLLECTION: &str = "rollback-witness-identity";
const SLOT_ONE: &str = "one.witness";
const SLOT_TWO: &str = "two.witness";
const IDENTITY_ONE: &str = "one.identity";
const IDENTITY_TWO: &str = "two.identity";

pub(super) fn commitment_unbound(commitment: &[u8; 32]) -> bool {
    *commitment == [0; 32]
}

pub(super) fn entry_plaintext_commitment(plaintext: &[u8]) -> [u8; 32] {
    *blake3::hash(plaintext).as_bytes()
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub(crate) struct EntryWitness {
    pub revision: u64,
    pub deleted: bool,
    /// BLAKE3 of bound plaintext (entry body or attachment manifest).
    /// `[0; 32]` for legacy entries, tombstones, and the attachment namespace marker.
    #[serde(default, skip_serializing_if = "commitment_unbound")]
    pub commitment: [u8; 32],
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Witness {
    version: u8,
    epoch: u64,
    entries: BTreeMap<String, EntryWitness>,
}

#[derive(Clone)]
pub(crate) struct WitnessRekey {
    store_id: String,
    witness: Witness,
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(DIGITS[usize::from(byte >> 4)]));
        out.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    out
}

#[path = "rollback_witness/attachments.rs"]
mod attachments;
#[cfg(test)]
#[path = "rollback_witness/attachments_tests.rs"]
mod attachments_tests;
#[path = "rollback_witness/commit_marker.rs"]
mod commit_marker;
#[cfg(test)]
#[path = "rollback_witness/commit_marker_tests.rs"]
mod commit_marker_tests;
#[path = "rollback_witness/migration.rs"]
mod migration;
#[path = "rollback_witness/normalize.rs"]
mod normalize;
#[path = "rollback_witness/persistence.rs"]
mod persistence;
#[path = "rollback_witness/rekey.rs"]
mod rekey;
#[cfg(test)]
#[path = "rollback_witness/rotation_marker_tests.rs"]
mod rotation_marker_tests;
#[path = "rollback_witness/slot_selection.rs"]
mod slot_selection;
#[path = "rollback_witness/trusted_recovery.rs"]
mod trusted_recovery;
#[path = "rollback_witness/entry_commitment.rs"]
mod entry_commitment;

#[cfg(test)]
#[path = "rollback_witness/entry_commitment_tests.rs"]
mod entry_commitment_tests;

impl StoreRoot {
    pub(super) fn migration_entry_witness_v1_upgrade(
        &self,
        name: &str,
        revision: u64,
        key: &ItemDataKey,
    ) -> Result<EntryWitness, StoreError> {
        if revision == 0 {
            return Err(StoreError::Crypto("invalid zero revision state".into()));
        }
        let relative = Self::entry_relative(name, "osseal")?;
        let path = self.path.join(&relative);
        if !path.exists() {
            return Ok(EntryWitness {
                revision,
                deleted: true,
                commitment: [0; 32],
            });
        }
        let blob = confined_read(&self.path, &relative)?;
        let plaintext = match open_osseal_for_path(&blob, key, name, Some(revision)) {
            Ok(opened) => opened.plaintext,
            Err(_) => open_legacy_for_trusted_migration(&blob, key)?,
        };
        Ok(EntryWitness {
            revision,
            deleted: false,
            commitment: entry_plaintext_commitment(&plaintext),
        })
    }

    pub(super) fn migration_entry_witness(
        &self,
        name: &str,
        revision: u64,
        key: &ItemDataKey,
    ) -> Result<EntryWitness, StoreError> {
        if revision == 0 {
            return Err(StoreError::Crypto("invalid zero revision state".into()));
        }
        let relative = Self::entry_relative(name, "osseal")?;
        let deleted = !self.path.join(&relative).exists();
        if deleted {
            return Ok(EntryWitness {
                revision,
                deleted: true,
                commitment: [0; 32],
            });
        }
        let opened = open_osseal_for_path(
            &confined_read(&self.path, &relative)?,
            key,
            name,
            Some(revision),
        )?;
        if opened.legacy {
            return Err(StoreError::Crypto(format!(
                "revision state for {name} points to legacy ciphertext"
            )));
        }
        Ok(EntryWitness {
            revision,
            deleted: false,
            commitment: entry_plaintext_commitment(&opened.plaintext),
        })
    }

    fn witness_from_current_store(&self, key: &ItemDataKey) -> Result<Witness, StoreError> {
        let revisions = self.revisions()?;
        let inventory = crate::rotation_walk::inventory(&self.path)?;
        let mut entries = BTreeMap::new();
        for (name, revision) in &revisions {
            entries.insert(
                name.clone(),
                self.migration_entry_witness(name, *revision, key)?,
            );
        }
        for name in inventory.entries {
            let relative = Self::entry_relative(&name, "osseal")?;
            let path = self.path.join(&relative);
            if !path.exists() || entries.contains_key(&name) {
                continue;
            }
            let opened =
                open_osseal_for_path(&confined_read(&self.path, &relative)?, key, &name, None)?;
            if !opened.legacy {
                return Err(StoreError::Crypto(format!(
                    "missing anti-rollback state for {name}; refusing ciphertext bootstrap"
                )));
            }
            entries.insert(
                name,
                EntryWitness {
                    revision: 1,
                    deleted: false,
                    commitment: [0; 32],
                },
            );
        }
        let mut witness = Witness {
            version: 2,
            epoch: 1,
            entries,
        };
        self.anchor_attachments(&mut witness, key)?;
        Ok(witness)
    }
    fn new_store_id() -> String {
        let mut random = [0_u8; 16];
        rand::rng().fill_bytes(&mut random);
        hex(&random)
    }
    fn persist_new_anchor(
        &self,
        key: &ItemDataKey,
        store_id: &str,
        witness: &Witness,
    ) -> Result<(), StoreError> {
        self.write_witness(store_id, key, witness)?;
        self.write_outside_identity(key, store_id)?;
        confined_replace(&self.path, Path::new(STORE_ID_FILE), store_id.as_bytes())?;
        Ok(())
    }
    fn initialize_fresh_witness(&self, key: &ItemDataKey) -> Result<(String, Witness), StoreError> {
        let inventory = crate::rotation_walk::inventory(&self.path)?;
        if !self.revisions()?.is_empty()
            || !inventory.entries.is_empty()
            || !self.attachment_revisions()?.is_empty()
            || !inventory.attachments.is_empty()
        {
            return Err(StoreError::Crypto(
                "outside rollback anchor is missing for an existing store; run the explicit rollback-anchor migration after verifying the current checkout"
                    .into(),
            ));
        }
        let store_id = Self::new_store_id();
        let mut witness = Witness {
            version: 2,
            epoch: 1,
            entries: BTreeMap::new(),
        };
        attachments::mark_empty(&mut witness);
        self.persist_new_anchor(key, &store_id, &witness)?;
        Ok((store_id, witness))
    }
    fn current_witness(&self, key: &ItemDataKey) -> Result<(String, Witness), StoreError> {
        let inside = self.read_store_id()?;
        let (store_id, mut witness) = match self.read_outside_identity(key)? {
            Some(identity) => {
                if inside.as_ref().is_some_and(|id| id != &identity.store_id) {
                    return Err(StoreError::Crypto(
                        "store identity does not match its outside rollback anchor".into(),
                    ));
                }
                let witness = match self.load_witness(&identity.store_id, key)? {
                    Some(witness) => witness,
                    None => {
                        return Err(StoreError::Crypto(
                            "rollback witness is missing; restore its outside-store checkpoint"
                                .into(),
                        ));
                    }
                };
                if inside.is_none() {
                    confined_replace(
                        &self.path,
                        Path::new(STORE_ID_FILE),
                        identity.store_id.as_bytes(),
                    )?;
                }
                Ok((identity.store_id, witness))
            }
            None if inside.is_some() => Err(StoreError::Crypto(
                "outside store identity anchor is missing; restore it instead of trusting the in-store identity"
                    .into(),
            )),
            None => self.initialize_fresh_witness(key),
        }?;
        witness.entries = normalize::entries(witness.entries)?;
        Ok((store_id, witness))
    }
    /// Explicitly anchors a pre-witness store after the operator has verified
    /// that its current checkout is the intended high-water state.
    pub fn migrate_rollback_anchor(&self, key: &ItemDataKey) -> Result<(), StoreError> {
        let _lock = StoreLock::exclusive_for_key(&self.path, key)?;
        if let Some(identity) = self.read_outside_identity(key)? {
            return self.migrate_existing_witness(key, &identity.store_id);
        }
        if self.read_store_id()?.is_some() {
            return Err(StoreError::Crypto(
                "store was already anchored; restore its outside rollback checkpoint".into(),
            ));
        }
        let witness = self.witness_from_current_store(key)?;
        let store_id = Self::new_store_id();
        self.persist_new_anchor(key, &store_id, &witness)
    }

    pub(crate) fn entry_witness(
        &self,
        name: &str,
        key: &ItemDataKey,
    ) -> Result<EntryWitness, StoreError> {
        let state = self
            .current_witness(key)?
            .1
            .entries
            .get(&crate::store::revision_identity(name)?)
            .copied()
            .ok_or_else(|| {
                StoreError::Crypto(format!(
                    "missing anti-rollback state for {name}; refusing ciphertext bootstrap"
                ))
            })?;
        if !state.deleted {
            if let Err(StoreError::Crypto(ref message)) =
                self.verify_entry_plaintext(name, key, &state)
            {
                if message.contains("does not match its rollback witness") {
                    return Err(StoreError::Crypto(message.clone()));
                }
            }
        }
        Ok(state)
    }

    pub(crate) fn next_entry_revision(
        &self,
        name: &str,
        path: &Path,
        key: &ItemDataKey,
    ) -> Result<u64, StoreError> {
        self.next_entry_revision_after(name, path, key, 0, None, false)
    }

    pub(crate) fn tombstone_entry(&self, name: &str, key: &ItemDataKey) -> Result<(), StoreError> {
        let (store_id, mut witness) = self.current_witness(key)?;
        let local = self.revision(name)?.unwrap_or(0);
        let identity = crate::store::revision_identity(name)?;
        let entry = witness
            .entries
            .get_mut(&identity)
            .ok_or_else(|| StoreError::Crypto(format!("missing anti-rollback state for {name}")))?;
        if entry.deleted {
            return self.record_revision(name, entry.revision.max(local));
        }
        entry.revision = entry
            .revision
            .max(local)
            .checked_add(1)
            .ok_or_else(|| StoreError::Crypto("entry revision exhausted".into()))?;
        let revision = entry.revision;
        entry.deleted = true;
        witness.epoch = witness
            .epoch
            .checked_add(1)
            .ok_or_else(|| StoreError::Crypto("rollback witness epoch exhausted".into()))?;
        self.write_witness(&store_id, key, &witness)?;
        self.record_revision(name, revision)
    }
}
