use super::*;
use crate::{init_store, init_store_key, AttachMeta, Entry};
use std::path::{Path, PathBuf};

fn seeded() -> (tempfile::TempDir, StoreRoot, ItemDataKey) {
    let dir = tempfile::tempdir().unwrap();
    let store = init_store(dir.path(), &[]).unwrap();
    let key = init_store_key(dir.path(), b"correct horse").unwrap();
    store
        .insert("Dev/token", &Entry::parse("secret"), &key)
        .unwrap();
    store
        .attach_add(
            "Docs/file",
            &mut std::io::Cursor::new(b"contents"),
            8,
            AttachMeta {
                filename: "file".into(),
                mime: None,
            },
            &key,
            false,
        )
        .unwrap();
    (dir, store, key)
}

#[test]
fn old_marker_is_pending_before_key_commit_even_if_second_slot_is_not_finished() {
    let (_dir, store, old_key) = seeded();
    let new_key = ItemDataKey::generate();
    let prepared = store.prepare_witness_rekey(&old_key).unwrap();
    store.write_rekeyed_witness(&prepared, &new_key).unwrap();
    assert!(store.entry_witness("Dev/token", &old_key).is_ok());
    assert!(store.current_witness(&new_key).is_ok());
    assert!(store.entry_witness("Dev/token", &new_key).is_err());

    store.mark_rotation_pending(&prepared, &old_key).unwrap();
    assert!(store.entry_witness("Dev/token", &old_key).is_err());
    assert!(store.attachment_witness("Docs/file", &old_key).is_err());
    assert!(store.current_witness(&new_key).is_ok());
    assert!(store.entry_witness("Dev/token", &new_key).is_err());
    assert!(store.write_rekeyed_witness(&prepared, &old_key).is_err());
    assert!(store.entry_witness("Dev/token", &old_key).is_err());
}

#[test]
fn interrupted_rotation_requires_staging_resolution_and_explicit_recovery() {
    let (dir, store, old_key) = seeded();
    let new_key = ItemDataKey::generate();
    let prepared = store.prepare_witness_rekey(&old_key).unwrap();
    store.write_rekeyed_witness(&prepared, &new_key).unwrap();
    store.mark_rotation_pending(&prepared, &old_key).unwrap();
    let staging = dir.path().join(crate::rotation::ROTATION_STAGING_DIR);
    std::fs::create_dir(&staging).unwrap();
    assert!(store.migrate_rollback_anchor(&old_key).is_err());
    std::fs::remove_dir(staging).unwrap();
    assert!(store.show("Dev/token", &old_key).is_err());
    // This command explicitly trusts the independently verified old checkout.
    store.migrate_rollback_anchor(&old_key).unwrap();
    assert!(store.show("Dev/token", &old_key).is_ok());
    assert!(store
        .attach_get("Docs/file", &mut Vec::new(), &old_key)
        .is_ok());
}

#[test]
fn explicit_recovery_cannot_recreate_a_missing_pending_witness() {
    let (_dir, store, old_key) = seeded();
    let new_key = ItemDataKey::generate();
    let prepared = store.prepare_witness_rekey(&old_key).unwrap();
    store.write_rekeyed_witness(&prepared, &new_key).unwrap();
    store.mark_rotation_pending(&prepared, &old_key).unwrap();
    let (root, directory) = store.witness_directory(&prepared.store_id).unwrap();
    std::fs::remove_file(root.join(directory).join(SLOT_TWO)).unwrap();
    assert!(store.migrate_rollback_anchor(&old_key).is_err());
    assert!(store
        .read_commit_marker(&prepared.store_id, &old_key)
        .unwrap()
        .unwrap()
        .is_rotation_pending());
}

#[test]
fn completed_root_rotation_leaves_old_key_marker_retired() {
    let (dir, store, old_key) = seeded();
    let (store_id, _) = store.current_witness(&old_key).unwrap();
    crate::rotate_store_root(dir.path(), b"correct horse", crate::RotationEdit::default()).unwrap();
    let marker = store
        .read_commit_marker(&store_id, &old_key)
        .unwrap()
        .unwrap();
    assert!(marker.is_rotation_pending());
    let new_key = crate::unlock_store_key(dir.path(), b"correct horse").unwrap();
    assert!(store.show("Dev/token", &new_key).is_ok());
    assert!(store
        .attach_get("Docs/file", &mut Vec::new(), &new_key)
        .is_ok());
}

fn checkout_files(root: &Path, relative: &Path, files: &mut Vec<(PathBuf, Vec<u8>)>) {
    for entry in std::fs::read_dir(root.join(relative)).unwrap() {
        let entry = entry.unwrap();
        let path = relative.join(entry.file_name());
        if path == Path::new(crate::store_lock::STORE_LOCK_FILE) {
            continue;
        }
        if entry.file_type().unwrap().is_dir() {
            checkout_files(root, &path, files);
        } else {
            assert!(entry.file_type().unwrap().is_file());
            files.push((path, std::fs::read(entry.path()).unwrap()));
        }
    }
}

fn restore_checkout(root: &Path, files: &[(PathBuf, Vec<u8>)]) {
    for entry in std::fs::read_dir(root).unwrap() {
        let entry = entry.unwrap();
        if entry.file_name() == crate::store_lock::STORE_LOCK_FILE {
            continue;
        }
        if entry.file_type().unwrap().is_dir() {
            std::fs::remove_dir_all(entry.path()).unwrap();
        } else {
            std::fs::remove_file(entry.path()).unwrap();
        }
    }
    for (relative, bytes) in files {
        let path = root.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }
}

#[test]
fn restoring_a_checkout_after_rotation_does_not_reactivate_its_old_key() {
    let (dir, store, old_key) = seeded();
    let (store_id, _) = store.current_witness(&old_key).unwrap();
    assert!(!store.witness_root().unwrap().starts_with(dir.path()));
    let mut old_checkout = Vec::new();
    checkout_files(dir.path(), Path::new(""), &mut old_checkout);

    crate::rotate_store_root(dir.path(), b"correct horse", crate::RotationEdit::default()).unwrap();
    let new_key = crate::unlock_store_key(dir.path(), b"correct horse").unwrap();
    assert!(store.show("Dev/token", &new_key).is_ok());
    restore_checkout(dir.path(), &old_checkout);

    let restored_key = crate::unlock_store_key(dir.path(), b"correct horse").unwrap();
    assert_eq!(restored_key.0, old_key.0);
    assert!(store.show("Dev/token", &restored_key).is_err());
    assert!(store
        .attach_get("Docs/file", &mut Vec::new(), &restored_key)
        .is_err());
    assert!(store
        .read_commit_marker(&store_id, &restored_key)
        .unwrap()
        .unwrap()
        .is_rotation_pending());
}
