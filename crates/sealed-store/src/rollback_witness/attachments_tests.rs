use super::*;
use crate::attachment::parse_attachment_manifest;
use crate::envelope::{open_osseal_in_for_path, seal_osseal_in, COLLECTION_ATTACHMENTS};
use crate::{init_store, init_store_key, AttachMeta, Entry};

const ATTACHMENT_MARKER: &str = ".attachments/.rollback-anchor-v1";
const ATTACHMENT_PREFIX: &str = ".attachments/.rollback-witness/";

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
        .retain(|name, _| name != ATTACHMENT_MARKER && !name.starts_with(ATTACHMENT_PREFIX));
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
    root.advance_attachment_witness("Docs/file", &path, &key, 1, None, false)
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

    let (opened, bound) = open_osseal_in_for_path(
        COLLECTION_ATTACHMENTS,
        &original,
        &key,
        "Docs/file",
        Some(witnessed.revision),
    )
    .unwrap();
    let mut manifest = parse_attachment_manifest(&opened.plaintext).unwrap();
    manifest.filename = "other-file".into();
    let plaintext = serde_json::to_vec(&manifest).unwrap();
    let forked = seal_osseal_in(
        COLLECTION_ATTACHMENTS,
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
        .advance_attachment_witness("Docs/file", &path, &key, witnessed.revision, None, false)
        .is_err());
    assert!(root
        .advance_attachment_witness(
            "Docs/file",
            &path,
            &key,
            witnessed.revision,
            Some(&plaintext),
            false,
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

#[test]
fn trusted_recovery_rebinds_forked_manifest() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = init_store_key(dir.path(), b"correct horse").unwrap();
    add(&root, &key, b"alpha", false);
    let path = dir.path().join("Docs/file.osattach");
    let original = std::fs::read(&path).unwrap();
    let witnessed = root.attachment_witness("Docs/file", &key).unwrap();
    let (opened, bound) = open_osseal_in_for_path(
        COLLECTION_ATTACHMENTS,
        &original,
        &key,
        "Docs/file",
        Some(witnessed.revision),
    )
    .unwrap();
    let mut manifest = parse_attachment_manifest(&opened.plaintext).unwrap();
    manifest.filename = "other-file".into();
    let plaintext = serde_json::to_vec(&manifest).unwrap();
    let forked = seal_osseal_in(
        COLLECTION_ATTACHMENTS,
        &plaintext,
        &key,
        &bound,
        witnessed.revision,
    )
    .unwrap();
    std::fs::write(&path, &forked).unwrap();
    assert!(root.attachment_witness("Docs/file", &key).is_err());
    assert!(root
        .advance_attachment_witness("Docs/file", &path, &key, witnessed.revision, None, false)
        .is_err());
    root.recover_attachment_trusting_ciphertext("Docs/file", &key)
        .unwrap();
    let rebound = root.attachment_witness("Docs/file", &key).unwrap();
    assert!(rebound.revision > witnessed.revision);
    assert_eq!(rebound.commitment, *blake3::hash(&plaintext).as_bytes());
    let mut out = Vec::new();
    let summary = root.attach_get("Docs/file", &mut out, &key).unwrap();
    assert_eq!(out, b"alpha");
    assert_eq!(summary.filename, "other-file");
}

#[test]
fn commitment_checked_bytes_reject_a_swapped_fork() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = init_store_key(dir.path(), b"correct horse").unwrap();
    add(&root, &key, b"alpha", false);
    let witnessed = root.attachment_witness("Docs/file", &key).unwrap();
    let blob = std::fs::read(dir.path().join("Docs/file.osattach")).unwrap();
    let (opened, _) = open_osseal_in_for_path(
        COLLECTION_ATTACHMENTS,
        &blob,
        &key,
        "Docs/file",
        Some(witnessed.revision),
    )
    .unwrap();
    let manifest =
        super::attachments::manifest_from_commitment(&witnessed, &opened.plaintext).unwrap();
    assert_eq!(manifest.filename, "file");

    let mut forked = parse_attachment_manifest(&opened.plaintext).unwrap();
    forked.filename = "swapped-fork".into();
    let swapped = serde_json::to_vec(&forked).unwrap();
    assert!(super::attachments::manifest_from_commitment(&witnessed, &swapped).is_err());
    let again =
        super::attachments::manifest_from_commitment(&witnessed, &opened.plaintext).unwrap();
    assert_eq!(again.filename, "file");
}

#[test]
fn rebind_failure_before_key_commit_leaves_the_old_key_file() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let password = b"correct horse";
    let key = init_store_key(dir.path(), password).unwrap();
    add(&root, &key, b"one", false);
    let (id, mut witness) = root.current_witness(&key).unwrap();
    witness.epoch = u64::MAX;
    root.write_witness(&id, &key, &witness).unwrap();
    let key_path = dir.path().join(crate::KEY_FILE_NAME);
    let before = std::fs::read(&key_path).unwrap();
    let Err(error) = crate::rotate_store_root(dir.path(), password, crate::RotationEdit::default())
    else {
        panic!("rebind must fail before the key file is replaced");
    };
    assert!(
        error
            .to_string()
            .contains("rollback witness epoch exhausted"),
        "{error}"
    );
    assert_eq!(std::fs::read(&key_path).unwrap(), before);
    assert_eq!(
        crate::unlock_store_key(dir.path(), password).unwrap().0,
        key.0
    );
    let mut out = Vec::new();
    root.attach_get("Docs/file", &mut out, &key).unwrap();
    assert_eq!(out, b"one");
    assert!(!dir.path().join(crate::ROTATION_STAGING_DIR).exists());
}
