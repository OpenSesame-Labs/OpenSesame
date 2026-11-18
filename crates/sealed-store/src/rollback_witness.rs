//! Authenticated high-water state held outside the Git/backup store root.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use opensesame_human_vault::ItemDataKey;
use rand::Rng;
use serde::{Deserialize, Serialize};

use crate::envelope::{open_osseal, open_osseal_in, seal_osseal_in};
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

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub(crate) struct EntryWitness {
    pub revision: u64,
    pub deleted: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Witness {
    version: u8,
    epoch: u64,
    entries: BTreeMap<String, EntryWitness>,
}

#[derive(Debug, Deserialize, Serialize)]
struct StoreIdentity {
    version: u8,
    locator: String,
    store_id: String,
}

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

fn valid_store_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

impl StoreRoot {
    #[cfg(test)]
    pub(crate) fn witness_root(&self) -> Result<PathBuf, StoreError> {
        Ok(self
            .path
            .parent()
            .ok_or_else(|| StoreError::InvalidPath("store has no parent".into()))?
            .join(".opensesame-test-rollback-witnesses")
            .join(self.store_locator()?))
    }

    #[cfg(not(test))]
    fn witness_root(&self) -> Result<PathBuf, StoreError> {
        directories::ProjectDirs::from("com", "OpenSesame", "OpenSesame")
            .map(|dirs| {
                dirs.data_local_dir()
                    .join("sealed-store-rollback-witnesses")
            })
            .ok_or_else(|| StoreError::Other("no local data directory for rollback witness".into()))
    }

    fn read_store_id(&self) -> Result<Option<String>, StoreError> {
        let path = self.path.join(STORE_ID_FILE);
        if !path.exists() {
            return Ok(None);
        }
        let bytes = confined_read(&self.path, Path::new(STORE_ID_FILE))?;
        let id = String::from_utf8(bytes)
            .map_err(|error| StoreError::Crypto(format!("invalid store identity: {error}")))?;
        if !valid_store_id(&id) {
            return Err(StoreError::Crypto("invalid store identity".into()));
        }
        Ok(Some(id))
    }

    fn witness_directory(&self, store_id: &str) -> Result<(PathBuf, PathBuf), StoreError> {
        let root = self.witness_root()?;
        #[cfg(not(windows))]
        Self::ensure_private_witness_root(&root)?;
        Ok((root, PathBuf::from(store_id)))
    }

    #[cfg(unix)]
    fn ensure_private_witness_root(root: &Path) -> Result<(), StoreError> {
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};

        let mut builder = fs::DirBuilder::new();
        builder.recursive(true).mode(0o700).create(root)?;
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(root)?;
        file.set_permissions(fs::Permissions::from_mode(0o700))?;
        Ok(())
    }

    #[cfg(not(any(unix, windows)))]
    fn ensure_private_witness_root(root: &Path) -> Result<(), StoreError> {
        fs::create_dir_all(root)?;
        Ok(())
    }

    fn store_locator(&self) -> Result<String, StoreError> {
        let canonical = fs::canonicalize(&self.path)?;
        let mut hasher = blake3::Hasher::new();
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            hasher.update(canonical.as_os_str().as_bytes());
        }
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            for unit in canonical.as_os_str().encode_wide() {
                hasher.update(&unit.to_le_bytes());
            }
        }
        #[cfg(not(any(unix, windows)))]
        hasher.update(canonical.to_string_lossy().as_bytes());
        Ok(hasher.finalize().to_hex().to_string())
    }

    fn identity_relative(locator: &str, slot: &str) -> PathBuf {
        Path::new("identities").join(locator).join(slot)
    }

    fn read_identity_slot(
        &self,
        key: &ItemDataKey,
        locator: &str,
        slot: &str,
    ) -> Result<Option<StoreIdentity>, StoreError> {
        let root = self.witness_root()?;
        #[cfg(not(windows))]
        Self::ensure_private_witness_root(&root)?;
        let relative = Self::identity_relative(locator, slot);
        if !root.join(&relative).exists() {
            return Ok(None);
        }
        let opened = open_osseal_in(
            IDENTITY_COLLECTION,
            &confined_read(&root, &relative)?,
            key,
            locator,
            Some(1),
        )?;
        let identity: StoreIdentity =
            serde_json::from_slice(&opened.plaintext).map_err(|error| {
                StoreError::Crypto(format!("invalid store identity anchor: {error}"))
            })?;
        if identity.version != 1
            || identity.locator != locator
            || !valid_store_id(&identity.store_id)
        {
            return Err(StoreError::Crypto("invalid store identity anchor".into()));
        }
        Ok(Some(identity))
    }

    fn read_outside_identity(
        &self,
        key: &ItemDataKey,
    ) -> Result<Option<StoreIdentity>, StoreError> {
        let locator = self.store_locator()?;
        let one = self.read_identity_slot(key, &locator, IDENTITY_ONE);
        let two = self.read_identity_slot(key, &locator, IDENTITY_TWO);
        match (one, two) {
            (Ok(None), Ok(None)) => Ok(None),
            (Ok(Some(identity)), Ok(None)) | (Ok(None), Ok(Some(identity))) => Ok(Some(identity)),
            (Ok(Some(one)), Ok(Some(two))) if one.store_id == two.store_id => Ok(Some(one)),
            (Ok(Some(_)), Ok(Some(_))) => Err(StoreError::Crypto(
                "outside store identity slots disagree".into(),
            )),
            (Ok(Some(identity)), Err(_)) | (Err(_), Ok(Some(identity))) => Ok(Some(identity)),
            (Err(one), Err(two)) => Err(StoreError::Crypto(format!(
                "outside store identity slots cannot be authenticated: {one}; {two}"
            ))),
            (Err(error), Ok(None)) | (Ok(None), Err(error)) => Err(error),
        }
    }

    fn write_outside_identity_slot(
        &self,
        key: &ItemDataKey,
        store_id: &str,
        slot: &str,
    ) -> Result<(), StoreError> {
        let root = self.witness_root()?;
        #[cfg(not(windows))]
        Self::ensure_private_witness_root(&root)?;
        let locator = self.store_locator()?;
        let identity = StoreIdentity {
            version: 1,
            locator: locator.clone(),
            store_id: store_id.to_string(),
        };
        let plaintext = serde_json::to_vec(&identity)
            .map_err(|error| StoreError::Crypto(format!("store identity anchor: {error}")))?;
        let sealed = seal_osseal_in(IDENTITY_COLLECTION, &plaintext, key, &locator, 1)?;
        confined_replace(&root, &Self::identity_relative(&locator, slot), &sealed)
    }

    fn write_outside_identity(&self, key: &ItemDataKey, store_id: &str) -> Result<(), StoreError> {
        self.write_outside_identity_slot(key, store_id, IDENTITY_ONE)?;
        self.write_outside_identity_slot(key, store_id, IDENTITY_TWO)
    }

    fn read_witness_slot(
        &self,
        root: &Path,
        relative: &Path,
        store_id: &str,
        key: &ItemDataKey,
    ) -> Result<Option<Witness>, StoreError> {
        if !root.join(relative).exists() {
            return Ok(None);
        }
        let opened = open_osseal_in(
            COLLECTION,
            &confined_read(root, relative)?,
            key,
            store_id,
            None,
        )?;
        let witness: Witness = serde_json::from_slice(&opened.plaintext)
            .map_err(|error| StoreError::Crypto(format!("invalid rollback witness: {error}")))?;
        if witness.version != 1
            || witness.epoch != opened.revision
            || witness.entries.values().any(|entry| entry.revision == 0)
        {
            return Err(StoreError::Crypto(
                "invalid rollback witness version or epoch".into(),
            ));
        }
        Ok(Some(witness))
    }

    fn load_witness(
        &self,
        store_id: &str,
        key: &ItemDataKey,
    ) -> Result<Option<Witness>, StoreError> {
        let (root, directory) = self.witness_directory(store_id)?;
        let one = self.read_witness_slot(&root, &directory.join(SLOT_ONE), store_id, key);
        let two = self.read_witness_slot(&root, &directory.join(SLOT_TWO), store_id, key);
        match (one, two) {
            (Ok(None), Ok(None)) => Ok(None),
            (Ok(Some(witness)), Ok(None)) | (Ok(None), Ok(Some(witness))) => Ok(Some(witness)),
            (Ok(Some(one)), Ok(Some(two))) => {
                Ok(Some(if one.epoch > two.epoch { one } else { two }))
            }
            // Root rotation intentionally rekeys the two redundant slots one
            // at a time. A crash between them leaves one authentic slot for
            // each key; either key path must be able to recover its copy.
            (Ok(Some(witness)), Err(_)) | (Err(_), Ok(Some(witness))) => Ok(Some(witness)),
            (Err(one), Err(two)) => Err(StoreError::Crypto(format!(
                "rollback witness slots cannot be authenticated: {one}; {two}"
            ))),
            (Err(error), Ok(None)) | (Ok(None), Err(error)) => Err(error),
        }
    }

    fn write_witness(
        &self,
        store_id: &str,
        key: &ItemDataKey,
        witness: &Witness,
    ) -> Result<(), StoreError> {
        let plaintext = serde_json::to_vec(witness)
            .map_err(|error| StoreError::Crypto(format!("rollback witness: {error}")))?;
        let sealed = seal_osseal_in(COLLECTION, &plaintext, key, store_id, witness.epoch)?;
        let slot = if witness.epoch.is_multiple_of(2) {
            SLOT_TWO
        } else {
            SLOT_ONE
        };
        self.write_witness_slot(store_id, slot, &sealed)
    }

    fn write_witness_slot(
        &self,
        store_id: &str,
        slot: &str,
        sealed: &[u8],
    ) -> Result<(), StoreError> {
        let (root, directory) = self.witness_directory(store_id)?;
        confined_replace(&root, &directory.join(slot), sealed)
    }

    fn migration_entry_witness(
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
            });
        }
        let opened = open_osseal(
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
            let opened = open_osseal(&confined_read(&self.path, &relative)?, key, &name, None)?;
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
                },
            );
        }
        Ok(Witness {
            version: 1,
            epoch: 1,
            entries,
        })
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
        self.write_outside_identity(key, store_id)?;
        self.write_witness(store_id, key, witness)?;
        confined_replace(&self.path, Path::new(STORE_ID_FILE), store_id.as_bytes())?;
        Ok(())
    }

    fn initialize_fresh_witness(&self, key: &ItemDataKey) -> Result<(String, Witness), StoreError> {
        if !self.revisions()?.is_empty()
            || !crate::rotation_walk::inventory(&self.path)?
                .entries
                .is_empty()
        {
            return Err(StoreError::Crypto(
                "outside rollback anchor is missing for an existing store; run the explicit rollback-anchor migration after verifying the current checkout"
                    .into(),
            ));
        }
        let store_id = Self::new_store_id();
        let witness = Witness {
            version: 1,
            epoch: 1,
            entries: BTreeMap::new(),
        };
        self.persist_new_anchor(key, &store_id, &witness)?;
        Ok((store_id, witness))
    }

    fn current_witness(&self, key: &ItemDataKey) -> Result<(String, Witness), StoreError> {
        let inside = self.read_store_id()?;
        match self.read_outside_identity(key)? {
            Some(identity) => {
                if inside.as_ref().is_some_and(|id| id != &identity.store_id) {
                    return Err(StoreError::Crypto(
                        "store identity does not match its outside rollback anchor".into(),
                    ));
                }
                let witness = match self.load_witness(&identity.store_id, key)? {
                    Some(witness) => witness,
                    None if inside.is_none()
                        && self.revisions()?.is_empty()
                        && crate::rotation_walk::inventory(&self.path)?.entries.is_empty() =>
                    {
                        let witness = Witness {
                            version: 1,
                            epoch: 1,
                            entries: BTreeMap::new(),
                        };
                        self.write_witness(&identity.store_id, key, &witness)?;
                        witness
                    }
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
        }
    }

    /// Explicitly anchors a pre-witness store after the operator has verified
    /// that its current checkout is the intended high-water state.
    pub fn migrate_rollback_anchor(&self, key: &ItemDataKey) -> Result<(), StoreError> {
        let _lock = StoreLock::exclusive_for_key(&self.path, key)?;
        if self.read_outside_identity(key)?.is_some() {
            return Err(StoreError::Other(
                "outside rollback anchor already exists".into(),
            ));
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
        self.current_witness(key)?
            .1
            .entries
            .get(name)
            .copied()
            .ok_or_else(|| {
                StoreError::Crypto(format!(
                    "missing anti-rollback state for {name}; refusing ciphertext bootstrap"
                ))
            })
    }

    pub(crate) fn next_entry_revision(
        &self,
        name: &str,
        path: &Path,
        key: &ItemDataKey,
    ) -> Result<u64, StoreError> {
        let (store_id, mut witness) = self.current_witness(key)?;
        if path.exists() && !witness.entries.contains_key(name) {
            return Err(StoreError::Crypto(format!(
                "missing anti-rollback state for {name}; refusing ciphertext bootstrap"
            )));
        }
        let current = witness.entries.get(name).map_or(0, |entry| entry.revision);
        let next = current
            .checked_add(1)
            .ok_or_else(|| StoreError::Crypto("entry revision exhausted".into()))?;
        witness.entries.insert(
            name.to_string(),
            EntryWitness {
                revision: next,
                deleted: false,
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

    pub(crate) fn tombstone_entry(&self, name: &str, key: &ItemDataKey) -> Result<(), StoreError> {
        let (store_id, mut witness) = self.current_witness(key)?;
        let entry = witness
            .entries
            .get_mut(name)
            .ok_or_else(|| StoreError::Crypto(format!("missing anti-rollback state for {name}")))?;
        if entry.deleted {
            return Ok(());
        }
        entry.deleted = true;
        witness.epoch = witness
            .epoch
            .checked_add(1)
            .ok_or_else(|| StoreError::Crypto("rollback witness epoch exhausted".into()))?;
        self.write_witness(&store_id, key, &witness)
    }

    pub(crate) fn prepare_witness_rekey(
        &self,
        old_key: &ItemDataKey,
    ) -> Result<WitnessRekey, StoreError> {
        let (store_id, witness) = self.current_witness(old_key)?;
        let prepared = WitnessRekey { store_id, witness };
        // Heal redundancy after a prior post-commit crash before overwriting
        // either pair for the next rotation. Slot two then remains a usable
        // current-key recovery path while slot one moves to the new key.
        self.write_rekeyed_witness(&prepared, old_key)?;
        self.finish_rekeyed_witness(&prepared, old_key)?;
        Ok(prepared)
    }

    pub(crate) fn write_rekeyed_witness(
        &self,
        prepared: &WitnessRekey,
        key: &ItemDataKey,
    ) -> Result<(), StoreError> {
        let plaintext = serde_json::to_vec(&prepared.witness)
            .map_err(|error| StoreError::Crypto(format!("rollback witness: {error}")))?;
        let sealed = seal_osseal_in(
            COLLECTION,
            &plaintext,
            key,
            &prepared.store_id,
            prepared.witness.epoch,
        )?;
        self.write_outside_identity_slot(key, &prepared.store_id, IDENTITY_ONE)?;
        self.write_witness_slot(&prepared.store_id, SLOT_ONE, &sealed)
    }

    pub(crate) fn finish_rekeyed_witness(
        &self,
        prepared: &WitnessRekey,
        key: &ItemDataKey,
    ) -> Result<(), StoreError> {
        let plaintext = serde_json::to_vec(&prepared.witness)
            .map_err(|error| StoreError::Crypto(format!("rollback witness: {error}")))?;
        let sealed = seal_osseal_in(
            COLLECTION,
            &plaintext,
            key,
            &prepared.store_id,
            prepared.witness.epoch,
        )?;
        self.write_outside_identity_slot(key, &prepared.store_id, IDENTITY_TWO)?;
        self.write_witness_slot(&prepared.store_id, SLOT_TWO, &sealed)
    }

    #[cfg(test)]
    pub(crate) fn write_first_rekeyed_witness_slot(
        &self,
        prepared: &WitnessRekey,
        key: &ItemDataKey,
    ) -> Result<(), StoreError> {
        let plaintext = serde_json::to_vec(&prepared.witness)
            .map_err(|error| StoreError::Crypto(format!("rollback witness: {error}")))?;
        let sealed = seal_osseal_in(
            COLLECTION,
            &plaintext,
            key,
            &prepared.store_id,
            prepared.witness.epoch,
        )?;
        self.write_outside_identity_slot(key, &prepared.store_id, IDENTITY_ONE)?;
        self.write_witness_slot(&prepared.store_id, SLOT_ONE, &sealed)
    }
}
