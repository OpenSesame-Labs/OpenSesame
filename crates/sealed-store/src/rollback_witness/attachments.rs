//! Attachment state in the reserved namespace of the existing outside witness.
use std::collections::BTreeSet;
use std::path::Path;

use super::{EntryWitness, Witness};
use crate::attachment::{attach_relative, parse_attachment_manifest};
use crate::envelope::{open_osseal_in_for_path, COLLECTION_ATTACHMENTS};
use crate::path::confined_read;
use crate::{ItemDataKey, StoreError, StoreRoot};

const MARKER: &str = ".attachments/.rollback-anchor-v1";
const PREFIX: &str = ".attachments/.rollback-witness/";

fn identity(name: &str) -> Result<String, StoreError> {
    Ok(format!(
        "{PREFIX}{}",
        crate::store::revision_identity(name)?
    ))
}

pub(super) fn marked(witness: &Witness) -> bool {
    witness
        .entries
        .get(MARKER)
        .is_some_and(|entry| entry.revision == 1 && !entry.deleted)
}

fn require_marker(witness: &Witness) -> Result<(), StoreError> {
    if marked(witness) {
        return Ok(());
    }
    Err(StoreError::Crypto("attachment rollback anchor is missing; verify the complete checkout and run migrate-rollback-anchor --accept-current-state".into()))
}

pub(super) fn mark_empty(witness: &mut Witness) {
    witness.entries.insert(
        MARKER.into(),
        EntryWitness {
            revision: 1,
            deleted: false,
        },
    );
}

impl StoreRoot {
    /// Called only in the explicit accept-current-state ceremony, under lock.
    pub(super) fn anchor_attachments(
        &self,
        witness: &mut Witness,
        key: &ItemDataKey,
    ) -> Result<(), StoreError> {
        if witness
            .entries
            .keys()
            .any(|name| name == MARKER || name.starts_with(PREFIX))
        {
            return Err(StoreError::Crypto(
                "attachment rollback namespace is already occupied".into(),
            ));
        }
        let revisions = self.attachment_revisions()?;
        let mut names = crate::rotation_walk::inventory(&self.path)?.attachments;
        names.extend(revisions.keys().cloned());
        for name in names {
            let relative = attach_relative(&name)?;
            let known = crate::store::revision_for(&revisions, &name)?;
            let state = if self.path.join(&relative).exists() {
                let blob = confined_read(&self.path, &relative)?;
                let (opened, _) =
                    open_osseal_in_for_path(COLLECTION_ATTACHMENTS, &blob, key, &name, known)?;
                parse_attachment_manifest(&opened.plaintext)?;
                EntryWitness {
                    revision: opened.revision,
                    deleted: false,
                }
            } else {
                EntryWitness {
                    revision: known
                        .ok_or_else(|| StoreError::Crypto("missing attachment revision".into()))?,
                    deleted: true,
                }
            };
            if state.revision == 0 {
                return Err(StoreError::Crypto("invalid attachment revision".into()));
            }
            witness.entries.insert(identity(&name)?, state);
        }
        mark_empty(witness);
        Ok(())
    }

    pub(super) fn upgrade_attachment_anchor(&self, key: &ItemDataKey) -> Result<(), StoreError> {
        let (store_id, mut witness) = self.current_witness(key)?;
        if marked(&witness) {
            return Err(StoreError::Other(
                "attachment rollback anchor already exists".into(),
            ));
        }
        self.anchor_attachments(&mut witness, key)?;
        witness.epoch = witness
            .epoch
            .checked_add(1)
            .ok_or_else(|| StoreError::Crypto("rollback witness epoch exhausted".into()))?;
        self.write_witness(&store_id, key, &witness)
    }

    pub(crate) fn attachment_witness_ready(&self, key: &ItemDataKey) -> Result<(), StoreError> {
        require_marker(&self.current_witness(key)?.1)
    }

    pub(crate) fn attachment_witness(
        &self,
        name: &str,
        key: &ItemDataKey,
    ) -> Result<EntryWitness, StoreError> {
        let (_, witness) = self.current_witness(key)?;
        require_marker(&witness)?;
        witness
            .entries
            .get(&identity(name)?)
            .copied()
            .ok_or_else(|| {
                StoreError::Crypto(format!("missing attachment anti-rollback state for {name}"))
            })
    }

    pub(crate) fn advance_attachment_witness(
        &self,
        name: &str,
        path: &Path,
        key: &ItemDataKey,
        minimum: u64,
    ) -> Result<u64, StoreError> {
        let (store_id, mut witness) = self.current_witness(key)?;
        require_marker(&witness)?;
        let name_key = identity(name)?;
        if path.exists() && !witness.entries.contains_key(&name_key) {
            return Err(StoreError::Crypto(format!(
                "missing attachment anti-rollback state for {name}"
            )));
        }
        let next = witness
            .entries
            .get(&name_key)
            .map_or(0, |state| state.revision)
            .max(minimum)
            .checked_add(1)
            .ok_or_else(|| StoreError::Crypto("attachment revision exhausted".into()))?;
        witness.entries.insert(
            name_key,
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
        Ok(next)
    }

    pub(crate) fn tombstone_attachment_witness(
        &self,
        name: &str,
        key: &ItemDataKey,
        minimum: u64,
    ) -> Result<u64, StoreError> {
        let (store_id, mut witness) = self.current_witness(key)?;
        require_marker(&witness)?;
        let state = witness
            .entries
            .get_mut(&identity(name)?)
            .ok_or_else(|| StoreError::Crypto("missing attachment anti-rollback state".into()))?;
        if state.deleted {
            return Ok(state.revision.max(minimum));
        }
        state.revision = state
            .revision
            .max(minimum)
            .checked_add(1)
            .ok_or_else(|| StoreError::Crypto("attachment revision exhausted".into()))?;
        state.deleted = true;
        let revision = state.revision;
        witness.epoch = witness
            .epoch
            .checked_add(1)
            .ok_or_else(|| StoreError::Crypto("rollback witness epoch exhausted".into()))?;
        self.write_witness(&store_id, key, &witness)?;
        Ok(revision)
    }

    pub(crate) fn verify_attachment_inventory(
        &self,
        key: &ItemDataKey,
        names: &BTreeSet<String>,
    ) -> Result<(), StoreError> {
        let (_, witness) = self.current_witness(key)?;
        require_marker(&witness)?;
        for (name, state) in &witness.entries {
            if let Some(name) = name.strip_prefix(PREFIX) {
                if !state.deleted && !names.contains(name) {
                    return Err(StoreError::Crypto(format!(
                        "witnessed attachment {name} is missing"
                    )));
                }
            }
        }
        Ok(())
    }

    /// Explicit per-file recovery may run before a separate full-store migration.
    pub(crate) fn recover_attachment_witness(
        &self,
        name: &str,
        path: &Path,
        key: &ItemDataKey,
        minimum: u64,
    ) -> Result<Option<u64>, StoreError> {
        if self.read_store_id()?.is_none() && self.read_outside_identity(key)?.is_none() {
            return Ok(None);
        }
        let (_, witness) = self.current_witness(key)?;
        if !marked(&witness) {
            return Ok(None);
        }
        self.advance_attachment_witness(name, path, key, minimum)
            .map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{init_store, init_store_key, AttachMeta, Entry};

    fn add(root: &StoreRoot, key: &ItemDataKey, bytes: &[u8], force: bool) {
        root.attach_add(
            "Docs/file",
            &mut std::io::Cursor::new(bytes),
            bytes.len() as u64,
            AttachMeta {
                filename: "file".into(),
                mime: None,
            },
            key,
            force,
        )
        .unwrap();
    }

    #[test]
    fn outside_witness_rejects_manifest_and_sidecar_rollback_and_resurrection() {
        let dir = tempfile::tempdir().unwrap();
        let root = init_store(dir.path(), &[]).unwrap();
        let key = init_store_key(dir.path(), b"correct horse").unwrap();
        add(&root, &key, b"old", false);
        let path = dir.path().join("Docs/file.osattach");
        let old = std::fs::read(&path).unwrap();
        let old_sidecar = std::fs::read(dir.path().join(crate::ATTACHMENT_REVISION_FILE)).unwrap();
        add(&root, &key, b"new", true);
        std::fs::write(&path, &old).unwrap();
        std::fs::write(
            dir.path().join(crate::ATTACHMENT_REVISION_FILE),
            &old_sidecar,
        )
        .unwrap();
        assert!(root.attach_get("Docs/file", &mut Vec::new(), &key).is_err());
        root.recover_attachment_trusting_ciphertext("Docs/file", &key)
            .unwrap();
        root.attach_rm("Docs/file", &key).unwrap();
        std::fs::write(&path, old).unwrap();
        assert!(root.attach_get("Docs/file", &mut Vec::new(), &key).is_err());
    }

    #[test]
    fn old_anchor_requires_explicit_whole_inventory_migration() {
        let dir = tempfile::tempdir().unwrap();
        let root = init_store(dir.path(), &[]).unwrap();
        let key = init_store_key(dir.path(), b"correct horse").unwrap();
        root.insert("entry", &Entry::parse("value"), &key).unwrap();
        add(&root, &key, b"one", false);
        let (id, mut witness) = root.current_witness(&key).unwrap();
        witness
            .entries
            .retain(|name, _| name != MARKER && !name.starts_with(PREFIX));
        witness.epoch += 1;
        root.write_witness(&id, &key, &witness).unwrap();
        assert!(root.attach_get("Docs/file", &mut Vec::new(), &key).is_err());
        let path = dir.path().join("Docs/file.osattach");
        let valid = std::fs::read(&path).unwrap();
        std::fs::write(&path, b"malformed").unwrap();
        assert!(root.migrate_rollback_anchor(&key).is_err());
        std::fs::write(&path, valid).unwrap();
        root.recover_attachment_trusting_ciphertext("Docs/file", &key)
            .unwrap();
        assert!(root.attach_get("Docs/file", &mut Vec::new(), &key).is_err());
        root.migrate_rollback_anchor(&key).unwrap();
        root.insert_or_replace("entry", &Entry::parse("updated"), &key)
            .unwrap();
        let mut out = Vec::new();
        root.attach_get("Docs/file", &mut out, &key).unwrap();
        assert_eq!(out, b"one");
        assert!(root.migrate_rollback_anchor(&key).is_err());
    }

    #[test]
    fn interrupted_mutation_requires_explicit_recovery() {
        let dir = tempfile::tempdir().unwrap();
        let root = init_store(dir.path(), &[]).unwrap();
        let key = init_store_key(dir.path(), b"correct horse").unwrap();
        add(&root, &key, b"one", false);
        let path = dir.path().join("Docs/file.osattach");
        let old = std::fs::read(&path).unwrap();
        root.advance_attachment_witness("Docs/file", &path, &key, 1)
            .unwrap();
        assert!(root.attach_get("Docs/file", &mut Vec::new(), &key).is_err());
        root.recover_attachment_trusting_ciphertext("Docs/file", &key)
            .unwrap();
        assert!(root.attach_get("Docs/file", &mut Vec::new(), &key).is_ok());
        std::fs::write(path, old).unwrap();
        assert!(root.attach_get("Docs/file", &mut Vec::new(), &key).is_err());
    }

    #[test]
    fn rotation_rekeys_attachment_witness_and_rejects_missing_live_manifests() {
        let dir = tempfile::tempdir().unwrap();
        let root = init_store(dir.path(), &[]).unwrap();
        let password = b"correct horse";
        let key = init_store_key(dir.path(), password).unwrap();
        add(&root, &key, b"one", false);
        let path = dir.path().join("Docs/file.osattach");
        let old = std::fs::read(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert!(root.attach_ls(None, &key).is_err());
        assert!(root.attach_gc(&key).is_err());
        assert!(
            crate::rotate_store_root(dir.path(), password, crate::RotationEdit::default()).is_err()
        );
        std::fs::write(&path, old).unwrap();
        crate::rotate_store_root(dir.path(), password, crate::RotationEdit::default()).unwrap();
        let new_key = crate::unlock_store_key(dir.path(), password).unwrap();
        let mut out = Vec::new();
        root.attach_get("Docs/file", &mut out, &new_key).unwrap();
        assert_eq!(out, b"one");
        assert!(root.attach_get("Docs/file", &mut Vec::new(), &key).is_err());
    }

    #[test]
    fn rotation_preserves_whitespace_bound_attachment_names() {
        let dir = tempfile::tempdir().unwrap();
        let root = init_store(dir.path(), &[]).unwrap();
        let password = b"correct horse";
        let key = init_store_key(dir.path(), password).unwrap();
        root.attach_add(
            "  Docs/file  ",
            &mut std::io::Cursor::new(b"content"),
            7,
            AttachMeta {
                filename: "file".into(),
                mime: None,
            },
            &key,
            false,
        )
        .unwrap();
        let mut before = Vec::new();
        root.attach_get("Docs/file", &mut before, &key).unwrap();
        assert_eq!(before, b"content");
        crate::rotate_store_root(dir.path(), password, crate::RotationEdit::default()).unwrap();
        let new_key = crate::unlock_store_key(dir.path(), password).unwrap();
        let mut after = Vec::new();
        root.attach_get("Docs/file", &mut after, &new_key).unwrap();
        assert_eq!(after, b"content");
    }
}
