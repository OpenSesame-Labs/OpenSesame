use super::{
    confined_read, confined_replace, Deserialize, ItemDataKey, Serialize, StoreError, StoreRoot,
    Witness, COLLECTION, IDENTITY_COLLECTION, IDENTITY_ONE, IDENTITY_TWO, SLOT_ONE, SLOT_TWO,
    STORE_ID_FILE,
};
use std::fs;
use std::path::{Path, PathBuf};

use crate::envelope::{open_osseal_in, seal_osseal_in};

#[derive(Debug, Deserialize, Serialize)]
pub(super) struct StoreIdentity {
    pub(super) version: u8,
    pub(super) locator: String,
    pub(super) store_id: String,
}

fn valid_store_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

impl StoreRoot {
    #[cfg(feature = "testkit")]
    fn injected_witness_root(&self) -> Option<PathBuf> {
        self.rollback_witness_root
            .clone()
            .or_else(|| std::env::var_os("OPENSESAME_TEST_ROLLBACK_WITNESS_DIR").map(PathBuf::from))
    }

    #[cfg(not(feature = "testkit"))]
    fn injected_witness_root(&self) -> Option<PathBuf> {
        None
    }

    #[cfg(test)]
    pub(crate) fn witness_root(&self) -> Result<PathBuf, StoreError> {
        if let Some(root) = self.injected_witness_root() {
            return Ok(root);
        }
        Ok(self
            .path
            .parent()
            .ok_or_else(|| StoreError::InvalidPath("store has no parent".into()))?
            .join(".opensesame-test-rollback-witnesses")
            .join(self.store_locator()?))
    }

    #[cfg(not(test))]
    fn witness_root(&self) -> Result<PathBuf, StoreError> {
        if let Some(root) = self.injected_witness_root() {
            return Ok(root);
        }
        directories::ProjectDirs::from("com", "OpenSesame", "OpenSesame")
            .map(|dirs| {
                dirs.data_local_dir()
                    .join("sealed-store-rollback-witnesses")
            })
            .ok_or_else(|| StoreError::Other("no local data directory for rollback witness".into()))
    }

    pub(super) fn read_store_id(&self) -> Result<Option<String>, StoreError> {
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

    pub(super) fn witness_directory(
        &self,
        store_id: &str,
    ) -> Result<(PathBuf, PathBuf), StoreError> {
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

    pub(super) fn read_outside_identity(
        &self,
        key: &ItemDataKey,
    ) -> Result<Option<StoreIdentity>, StoreError> {
        let locator = self.store_locator()?;
        let one = self.read_identity_slot(key, &locator, IDENTITY_ONE);
        let two = self.read_identity_slot(key, &locator, IDENTITY_TWO);
        match (one, two) {
            (Ok(None), Ok(None)) => Ok(None),
            // One authenticated slot is enough while the other is absent or
            // unreadable; two authenticated slots must agree.
            (Ok(Some(identity)), Ok(None) | Err(_)) | (Ok(None) | Err(_), Ok(Some(identity))) => {
                Ok(Some(identity))
            }
            (Ok(Some(one)), Ok(Some(two))) if one.store_id == two.store_id => Ok(Some(one)),
            (Ok(Some(_)), Ok(Some(_))) => Err(StoreError::Crypto(
                "outside store identity slots disagree".into(),
            )),
            (Err(one), Err(two)) => Err(StoreError::Crypto(format!(
                "outside store identity slots cannot be authenticated: {one}; {two}"
            ))),
            (Err(error), Ok(None)) | (Ok(None), Err(error)) => Err(error),
        }
    }

    pub(super) fn write_outside_identity_slot(
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

    pub(super) fn write_outside_identity(
        &self,
        key: &ItemDataKey,
        store_id: &str,
    ) -> Result<(), StoreError> {
        self.write_outside_identity_slot(key, store_id, IDENTITY_ONE)?;
        self.write_outside_identity_slot(key, store_id, IDENTITY_TWO)
    }

    pub(super) fn read_witness_slot(
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
        if !matches!(witness.version, 1 | 2)
            || witness.epoch != opened.revision
            || witness.entries.values().any(|entry| entry.revision == 0)
        {
            return Err(StoreError::Crypto(
                "invalid rollback witness version or epoch".into(),
            ));
        }
        Ok(Some(witness))
    }

    pub(super) fn load_witness(
        &self,
        store_id: &str,
        key: &ItemDataKey,
    ) -> Result<Option<Witness>, StoreError> {
        let (root, directory) = self.witness_directory(store_id)?;
        let one = Self::read_witness_slot(&root, &directory.join(SLOT_ONE), store_id, key);
        let two = Self::read_witness_slot(&root, &directory.join(SLOT_TWO), store_id, key);
        let Some(marker) = self.read_commit_marker(store_id, key)? else {
            if matches!((&one, &two), (Ok(None), Ok(None))) {
                return Ok(None);
            }
            return Err(StoreError::Crypto(
                "rollback commit marker is missing; restore it or explicitly migrate a verified legacy checkpoint".into(),
            ));
        };
        marker.require_active()?;
        for witness in [one, two].into_iter().filter_map(Result::ok).flatten() {
            if witness.version == 2 && marker.matches(&witness)? {
                return Ok(Some(witness));
            }
        }
        Err(StoreError::Crypto(
            "the committed rollback witness is missing or cannot be authenticated".into(),
        ))
    }

    pub(super) fn write_witness_slot(
        &self,
        store_id: &str,
        slot: &str,
        sealed: &[u8],
    ) -> Result<(), StoreError> {
        let (root, directory) = self.witness_directory(store_id)?;
        confined_replace(&root, &directory.join(slot), sealed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{init_store, init_store_key, Entry};

    fn seeded_witness() -> (tempfile::TempDir, StoreRoot, ItemDataKey) {
        let dir = tempfile::tempdir().unwrap();
        let store = init_store(dir.path(), &[]).unwrap();
        let key = init_store_key(dir.path(), b"correct horse").unwrap();
        store
            .insert("Dev/token", &Entry::parse("hunter2"), &key)
            .unwrap();
        (dir, store, key)
    }

    #[test]
    fn either_key_recovers_if_rekey_stops_after_one_witness_slot() {
        let (_dir, store, old_key) = seeded_witness();
        let new_key = ItemDataKey::generate();
        let prepared = store.prepare_witness_rekey(&old_key).unwrap();
        store
            .write_first_rekeyed_witness_slot(&prepared, &new_key)
            .unwrap();
        // Both keys recover the witness document. The new key cannot open the
        // entry ciphertext yet, so entry_witness stays fail-closed.
        assert_eq!(
            recovered_revision(&store, &old_key),
            recovered_revision(&store, &new_key)
        );
        assert!(store.entry_witness("Dev/token", &old_key).is_ok());
        assert!(store.entry_witness("Dev/token", &new_key).is_err());
    }

    #[test]
    fn next_rekey_heals_a_prior_one_slot_rekey_before_overwriting_it() {
        let (_dir, store, old_key) = seeded_witness();
        let current_key = ItemDataKey::generate();
        let interrupted = store.prepare_witness_rekey(&old_key).unwrap();
        store
            .write_first_rekeyed_witness_slot(&interrupted, &current_key)
            .unwrap();

        let next = store.prepare_witness_rekey(&current_key).unwrap();
        let future_key = ItemDataKey::generate();
        store
            .write_first_rekeyed_witness_slot(&next, &future_key)
            .unwrap();
        assert_eq!(
            recovered_revision(&store, &current_key),
            recovered_revision(&store, &future_key)
        );
        assert!(store.entry_witness("Dev/token", &current_key).is_err());
        assert!(store.entry_witness("Dev/token", &future_key).is_err());
    }

    fn recovered_revision(store: &StoreRoot, key: &ItemDataKey) -> u64 {
        store
            .current_witness(key)
            .unwrap()
            .1
            .entries
            .get("Dev/token")
            .expect("witness entry")
            .revision
    }
}
