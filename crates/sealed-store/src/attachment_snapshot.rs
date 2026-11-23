//! A consistent, passphrase-free snapshot for client-driven attachment backup.

use std::path::{Path, PathBuf};

use crate::path::{confined_read_bounded, confined_write};
use crate::store_lock::StoreLock;
use crate::{StoreError, StoreRoot};

// The gateway accepts at most this much for a sealed manifest. Cap total
// scratch use as well; callers can retry after freeing space or reducing the
// number of attachments rather than exhausting the machine.
const MAX_MANIFEST_BYTES: usize = 1_048_576;
const MAX_SNAPSHOT_BYTES: usize = 256 * 1_048_576;

/// Check a replication chunk against its content-addressed ciphertext name.
#[must_use]
pub fn verify_replication_chunk(digest: &str, bytes: &[u8]) -> bool {
    !bytes.is_empty()
        && digest.len() == 64
        && blake3::hash(bytes)
            .to_hex()
            .as_str()
            .eq_ignore_ascii_case(digest)
}

impl StoreRoot {
    /// Capture inventory and manifest bytes while excluding store mutations.
    ///
    /// `scratch` must be an empty, private directory outside the store and is
    /// owned and cleaned by the caller. Returned manifest paths are copies in
    /// scratch; chunk paths point at content-addressed files in the store.
    /// After this function releases the lock, a missing or modified chunk must
    /// fail replication before any manifest is published. No key is used, so
    /// this cannot authenticate a manifest or discover a chunk already
    /// missing from one. Existing local counters reject mismatched advertised
    /// revisions, but neither the header nor the counters prove freshness.
    ///
    /// # Errors
    ///
    /// Returns an error if the store is busy, scratch is unsafe, inventory
    /// fails, or a manifest exceeds the per-file or total snapshot limit.
    pub fn attach_replication_snapshot(
        &self,
        scratch: &Path,
    ) -> Result<Vec<(String, PathBuf)>, StoreError> {
        let scratch_real = std::fs::canonicalize(scratch)?;
        let store_real = std::fs::canonicalize(&self.path)?;
        if scratch_real.starts_with(&store_real)
            || store_real.starts_with(&scratch_real)
            || std::fs::read_dir(scratch)?.next().is_some()
        {
            return Err(StoreError::InvalidPath(
                "attachment snapshot needs an empty private directory outside the store".into(),
            ));
        }

        // The shared lock coexists with other readers but excludes writes,
        // GC, and rotation. Keep it only for inventory and manifest copying,
        // never during a network upload.
        let _lock = StoreLock::shared(&self.path)?;
        let mut units = self.attach_replication_units()?;
        let revisions = self.attachment_revisions()?;
        let mut total = 0usize;
        for (relative, source) in &mut units {
            let Some(name) = relative.strip_suffix(".osattach") else {
                continue;
            };
            let rel = Path::new(relative);
            let bytes = confined_read_bounded(&self.path, rel, MAX_MANIFEST_BYTES)?;
            if let Some(expected) = crate::store::revision_for(&revisions, name)? {
                require_advertised_revision(name, &bytes, expected)?;
            }
            total = total
                .checked_add(bytes.len())
                .ok_or_else(|| StoreError::Other("attachment snapshot size overflow".into()))?;
            if total > MAX_SNAPSHOT_BYTES {
                return Err(StoreError::Other(
                    "attachment manifests exceed the snapshot size limit".into(),
                ));
            }
            confined_write(scratch, rel, &bytes)?;
            *source = scratch.join(rel);
        }
        Ok(units)
    }
}

/// This is only a fail-closed comparison with the local counter. The
/// cleartext header has not been authenticated.
fn require_advertised_revision(name: &str, bytes: &[u8], expected: u64) -> Result<(), StoreError> {
    if crate::envelope::envelope_revision(bytes)? == expected {
        Ok(())
    } else {
        Err(StoreError::Crypto(format!(
            "attachment {name} revision does not match local state"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{init_store, init_store_key, AttachMeta};

    fn add(root: &StoreRoot, key: &crate::ItemDataKey, bytes: &[u8], force: bool) {
        root.attach_add(
            "Taxes/2025",
            &mut std::io::Cursor::new(bytes),
            bytes.len() as u64,
            AttachMeta {
                filename: "taxes.pdf".into(),
                mime: None,
            },
            key,
            force,
        )
        .unwrap();
    }

    #[test]
    fn snapshot_keeps_the_old_manifest_after_a_concurrent_update() {
        let dir = tempfile::tempdir().unwrap();
        let root = init_store(dir.path(), &[]).unwrap();
        let key = init_store_key(dir.path(), b"correct horse").unwrap();
        add(&root, &key, b"first version", false);
        let scratch = tempfile::tempdir().unwrap();
        let units = root.attach_replication_snapshot(scratch.path()).unwrap();
        let (_, manifest) = units
            .iter()
            .find(|(rel, _)| rel.ends_with(".osattach"))
            .unwrap();
        let original = std::fs::read(manifest).unwrap();
        assert!(manifest.starts_with(scratch.path()));
        assert!(units
            .iter()
            .any(|(rel, path)| rel.ends_with(".oschunk") && path.starts_with(dir.path())));

        add(&root, &key, b"second version", true);
        assert_eq!(std::fs::read(manifest).unwrap(), original);
        assert_ne!(
            std::fs::read(dir.path().join("Taxes/2025.osattach")).unwrap(),
            original
        );
    }

    #[test]
    fn snapshot_refuses_a_writer_and_nonempty_or_overlapping_scratch() {
        let dir = tempfile::tempdir().unwrap();
        let root = init_store(dir.path(), &[]).unwrap();
        let scratch = tempfile::tempdir().unwrap();
        let lock = StoreLock::exclusive(dir.path()).unwrap();
        assert!(root.attach_replication_snapshot(scratch.path()).is_err());
        drop(lock);
        std::fs::write(scratch.path().join("existing"), b"x").unwrap();
        assert!(root.attach_replication_snapshot(scratch.path()).is_err());
        assert!(root.attach_replication_snapshot(dir.path()).is_err());
    }

    #[test]
    fn snapshot_refuses_an_oversized_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let root = init_store(dir.path(), &[]).unwrap();
        std::fs::write(
            dir.path().join("huge.osattach"),
            vec![0; MAX_MANIFEST_BYTES + 1],
        )
        .unwrap();
        let scratch = tempfile::tempdir().unwrap();
        assert!(root.attach_replication_snapshot(scratch.path()).is_err());
    }

    #[test]
    fn snapshot_refuses_a_replayed_manifest_when_local_counter_is_intact() {
        let dir = tempfile::tempdir().unwrap();
        let root = init_store(dir.path(), &[]).unwrap();
        let key = init_store_key(dir.path(), b"correct horse").unwrap();
        add(&root, &key, b"old", false);
        let path = dir.path().join("Taxes/2025.osattach");
        let old = std::fs::read(&path).unwrap();
        add(&root, &key, b"new", true);
        std::fs::write(&path, &old).unwrap();
        let scratch = tempfile::tempdir().unwrap();
        assert!(root.attach_replication_snapshot(scratch.path()).is_err());
    }

    #[test]
    fn snapshot_checks_do_not_authenticate_headers_or_replace_a_witness() {
        let dir = tempfile::tempdir().unwrap();
        let root = init_store(dir.path(), &[]).unwrap();
        let key = init_store_key(dir.path(), b"correct horse").unwrap();
        add(&root, &key, b"old", false);
        let path = dir.path().join("Taxes/2025.osattach");
        let old = std::fs::read(&path).unwrap();
        add(&root, &key, b"new", true);

        // The unkeyed snapshot can be fooled by editing the advertised
        // revision. A keyed read still rejects the altered AEAD context.
        let mut body: serde_json::Value =
            serde_json::from_slice(&old[crate::OSSEAL_MAGIC.len()..]).unwrap();
        body["envelope"]["ad"]["revision"] = 2.into();
        let mut forged = crate::OSSEAL_MAGIC.to_vec();
        forged.extend(serde_json::to_vec(&body).unwrap());
        std::fs::write(&path, forged).unwrap();
        let scratch = tempfile::tempdir().unwrap();
        assert!(root.attach_replication_snapshot(scratch.path()).is_ok());
        assert!(root
            .attach_get("Taxes/2025", &mut Vec::new(), &key)
            .is_err());

        // A clone has no tracked local counter; it cannot prove whether the
        // valid old manifest is fresh without an independent witness.
        std::fs::write(path, old).unwrap();
        std::fs::remove_file(dir.path().join(crate::ATTACHMENT_REVISION_FILE)).unwrap();
        let scratch = tempfile::tempdir().unwrap();
        assert!(root.attach_replication_snapshot(scratch.path()).is_ok());
    }
}
