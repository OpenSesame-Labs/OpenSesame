//! Attachment state in the reserved namespace of the existing outside witness.
//!
//! A live attachment entry commits to the exact manifest plaintext. Revision
//! alone is not enough: two forks of one checkpoint can seal different
//! manifests under the same name and revision.
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

fn manifest_commitment(plaintext: &[u8]) -> [u8; 32] {
    *blake3::hash(plaintext).as_bytes()
}

fn manifest_matches(state: &EntryWitness, plaintext: &[u8]) -> bool {
    state.commitment != [0; 32] && state.commitment == manifest_commitment(plaintext)
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
            commitment: [0; 32],
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
                    commitment: manifest_commitment(&opened.plaintext),
                }
            } else {
                EntryWitness {
                    revision: known
                        .ok_or_else(|| StoreError::Crypto("missing attachment revision".into()))?,
                    deleted: true,
                    commitment: [0; 32],
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

    fn open_manifest_plaintext(
        &self,
        name: &str,
        key: &ItemDataKey,
        revision: u64,
    ) -> Result<Vec<u8>, StoreError> {
        let relative = attach_relative(name)?;
        if !self.path.join(&relative).exists() {
            return Err(StoreError::Crypto(format!(
                "witnessed attachment {name} is missing"
            )));
        }
        let blob = confined_read(&self.path, &relative)?;
        let (opened, _) =
            open_osseal_in_for_path(COLLECTION_ATTACHMENTS, &blob, key, name, Some(revision))?;
        Ok(opened.plaintext)
    }

    fn require_manifest_commitment(
        &self,
        name: &str,
        key: &ItemDataKey,
        state: &EntryWitness,
    ) -> Result<(), StoreError> {
        let plaintext = self.open_manifest_plaintext(name, key, state.revision)?;
        if !manifest_matches(state, &plaintext) {
            return Err(StoreError::Crypto(
                "attachment manifest does not match its rollback witness".into(),
            ));
        }
        Ok(())
    }

    pub(crate) fn attachment_witness(
        &self,
        name: &str,
        key: &ItemDataKey,
    ) -> Result<EntryWitness, StoreError> {
        let (_, witness) = self.current_witness(key)?;
        require_marker(&witness)?;
        let state = witness
            .entries
            .get(&identity(name)?)
            .copied()
            .ok_or_else(|| {
                StoreError::Crypto(format!("missing attachment anti-rollback state for {name}"))
            })?;
        if !state.deleted {
            self.require_manifest_commitment(name, key, &state)?;
        }
        Ok(state)
    }

    pub(crate) fn advance_attachment_witness(
        &self,
        name: &str,
        path: &Path,
        key: &ItemDataKey,
        minimum: u64,
        manifest_plaintext: Option<&[u8]>,
    ) -> Result<u64, StoreError> {
        let (store_id, mut witness) = self.current_witness(key)?;
        require_marker(&witness)?;
        let name_key = identity(name)?;
        if path.exists() && !witness.entries.contains_key(&name_key) {
            return Err(StoreError::Crypto(format!(
                "missing attachment anti-rollback state for {name}"
            )));
        }
        if let Some(state) = witness.entries.get(&name_key).copied() {
            // A same-revision fork authenticates under the witnessed revision.
            // An interrupted write does not, and recovery may replace it.
            if !state.deleted && path.exists() {
                match self.open_manifest_plaintext(name, key, state.revision) {
                    Ok(plaintext) if !manifest_matches(&state, &plaintext) => {
                        return Err(StoreError::Crypto(
                            "attachment manifest does not match its rollback witness".into(),
                        ));
                    }
                    Ok(_) => {}
                    Err(StoreError::Crypto(_)) => {}
                    Err(error) => return Err(error),
                }
            }
        }
        let commitment = match manifest_plaintext {
            Some(plaintext) => {
                parse_attachment_manifest(plaintext)?;
                manifest_commitment(plaintext)
            }
            None => [0; 32],
        };
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
                commitment,
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
        manifest_plaintext: &[u8],
    ) -> Result<Option<u64>, StoreError> {
        if self.read_store_id()?.is_none() && self.read_outside_identity(key)?.is_none() {
            return Ok(None);
        }
        let (_, witness) = self.current_witness(key)?;
        if !marked(&witness) {
            return Ok(None);
        }
        self.advance_attachment_witness(name, path, key, minimum, Some(manifest_plaintext))
            .map(Some)
    }

    /// Rotation reseals manifests under the new root, which changes chunk
    /// ciphertext digests and therefore the manifest plaintext. Publish that
    /// new commitment before the redundant witness slot is restored.
    pub(crate) fn rebind_rotated_attachments(
        &self,
        prepared: &mut super::WitnessRekey,
        key: &ItemDataKey,
    ) -> Result<(), StoreError> {
        let names: Vec<String> = prepared
            .witness
            .entries
            .keys()
            .filter_map(|name| name.strip_prefix(PREFIX).map(str::to_string))
            .collect();
        let mut changed = false;
        for name in names {
            let id = identity(&name)?;
            let Some(state) = prepared.witness.entries.get(&id).copied() else {
                continue;
            };
            if state.deleted {
                continue;
            }
            let plaintext = self.open_manifest_plaintext(&name, key, state.revision)?;
            let commitment = manifest_commitment(&plaintext);
            if commitment == state.commitment {
                continue;
            }
            let Some(entry) = prepared.witness.entries.get_mut(&id) else {
                continue;
            };
            entry.commitment = commitment;
            changed = true;
        }
        if !changed {
            return Ok(());
        }
        prepared.witness.epoch = prepared
            .witness
            .epoch
            .checked_add(1)
            .ok_or_else(|| StoreError::Crypto("rollback witness epoch exhausted".into()))?;
        self.write_witness(&prepared.store_id, key, &prepared.witness)
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
        root.advance_attachment_witness("Docs/file", &path, &key, 1, None)
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

    #[test]
    fn same_revision_forked_manifest_fails_witness_check() {
        let dir = tempfile::tempdir().unwrap();
        let root = init_store(dir.path(), &[]).unwrap();
        let key = init_store_key(dir.path(), b"correct horse").unwrap();
        add(&root, &key, b"alpha", false);
        let path = dir.path().join("Docs/file.osattach");
        let original = std::fs::read(&path).unwrap();
        let witnessed = root.attachment_witness("Docs/file", &key).unwrap();
        assert!(!witnessed.deleted);
        assert_ne!(witnessed.commitment, [0; 32]);

        let (opened, bound) = super::open_osseal_in_for_path(
            super::COLLECTION_ATTACHMENTS,
            &original,
            &key,
            "Docs/file",
            Some(witnessed.revision),
        )
        .unwrap();
        let mut manifest = super::parse_attachment_manifest(&opened.plaintext).unwrap();
        manifest.filename = "other-file".into();
        let plaintext = serde_json::to_vec(&manifest).unwrap();
        let forked = crate::envelope::seal_osseal_in(
            super::COLLECTION_ATTACHMENTS,
            &plaintext,
            &key,
            &bound,
            witnessed.revision,
        )
        .unwrap();
        assert_ne!(forked, original);
        std::fs::write(&path, &forked).unwrap();

        assert!(root.attachment_witness("Docs/file", &key).is_err());
        assert!(root
            .advance_attachment_witness(
                "Docs/file",
                &path,
                &key,
                witnessed.revision,
                Some(&plaintext),
            )
            .is_err());
        assert!(root.attach_get("Docs/file", &mut Vec::new(), &key).is_err());

        std::fs::write(&path, original).unwrap();
        let restored = root.attachment_witness("Docs/file", &key).unwrap();
        assert_eq!(restored.revision, witnessed.revision);
        assert_eq!(restored.commitment, witnessed.commitment);
        let mut out = Vec::new();
        root.attach_get("Docs/file", &mut out, &key).unwrap();
        assert_eq!(out, b"alpha");
    }
}
