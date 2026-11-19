use super::*;
use crate::store::{init_store, init_store_key};
use tempfile::TempDir;

fn store() -> (TempDir, StoreRoot, ItemDataKey) {
    let dir = TempDir::new().expect("tempdir");
    let root = init_store(dir.path(), &[]).expect("init");
    let key = init_store_key(dir.path(), b"correct horse").expect("key");
    (dir, root, key)
}

fn add(root: &StoreRoot, key: &ItemDataKey, name: &str, bytes: &[u8]) -> AttachmentSummary {
    let mut source = std::io::Cursor::new(bytes.to_vec());
    root.attach_add(
        name,
        &mut source,
        u64::try_from(bytes.len()).expect("fixture length fits u64"),
        AttachMeta {
            filename: "scan.pdf".into(),
            mime: None,
        },
        key,
        false,
    )
    .expect("attach_add")
}

fn get(root: &StoreRoot, key: &ItemDataKey, name: &str) -> Result<Vec<u8>, StoreError> {
    let mut sink: Vec<u8> = Vec::new();
    root.attach_get(name, &mut sink, key)?;
    Ok(sink)
}

#[test]
fn reading_a_missing_attachment_does_not_initialize_a_witness_under_a_shared_lock() {
    let (dir, root, key) = store();
    let identity = dir.path().join(".opensesame-store-id");
    assert!(!identity.exists());
    assert!(get(&root, &key, "One/missing").is_err());
    assert!(!identity.exists());
}

#[test]
fn first_authenticated_read_persists_revision_and_rejects_replay_after_restart() {
    let (dir, root, key) = store();
    add(&root, &key, "One/scan", b"old");
    let rel = attach_relative("One/scan").unwrap();
    let old = confined_read(&root.path, &rel).unwrap();
    root.attach_add(
        "One/scan",
        &mut std::io::Cursor::new(b"new"),
        3,
        AttachMeta {
            filename: "scan.pdf".into(),
            mime: None,
        },
        &key,
        true,
    )
    .unwrap();
    // A fresh clone does not carry the untracked revision map.
    std::fs::remove_file(root.path.join(ATTACHMENT_REVISION_FILE)).unwrap();
    let reopened = StoreRoot::open(dir.path()).unwrap();
    assert_eq!(get(&reopened, &key, "One/scan").unwrap(), b"new");
    assert_eq!(reopened.attachment_revisions().unwrap()["One/scan"], 2);

    // The newly recorded counter survives process restart and rejects a
    // valid but older manifest as long as the local sidecar is intact.
    drop(reopened);
    confined_write(dir.path(), &rel, &old).unwrap();
    let restarted = StoreRoot::open(dir.path()).unwrap();
    assert!(get(&restarted, &key, "One/scan").is_err());
    assert_eq!(restarted.attachment_revisions().unwrap()["One/scan"], 2);
}

#[test]
fn first_read_records_nothing_if_authentication_or_parsing_fails() {
    let (_dir, root, key) = store();
    add(&root, &key, "One/scan", b"content");
    let rel = attach_relative("One/scan").unwrap();
    let valid = confined_read(&root.path, &rel).unwrap();
    let revisions = root.path.join(ATTACHMENT_REVISION_FILE);
    std::fs::remove_file(&revisions).unwrap();
    assert!(get(&root, &ItemDataKey::generate(), "One/scan").is_err());
    assert!(!revisions.exists());

    // Even a valid envelope cannot initialize state with a malformed body.
    let malformed = seal_osseal_in(
        COLLECTION_ATTACHMENTS,
        b"not a manifest",
        &key,
        "One/scan",
        900,
    )
    .unwrap();
    confined_write(&root.path, &rel, &malformed).unwrap();
    assert!(get(&root, &key, "One/scan").is_err());
    assert!(!revisions.exists());
    confined_write(&root.path, &rel, &valid).unwrap();
    assert_eq!(get(&root, &key, "One/scan").unwrap(), b"content");
    assert_eq!(root.attachment_revisions().unwrap()["One/scan"], 1);
}

#[test]
fn first_read_refuses_a_concurrent_writer_before_initializing() {
    let (_dir, root, key) = store();
    add(&root, &key, "One/scan", b"content");
    let revisions = root.path.join(ATTACHMENT_REVISION_FILE);
    std::fs::remove_file(&revisions).unwrap();
    let held = crate::store_lock::StoreLock::key_file_edit(&root.path).unwrap();
    assert!(get(&root, &key, "One/scan").is_err());
    assert!(!revisions.exists());
    drop(held);
    assert_eq!(get(&root, &key, "One/scan").unwrap(), b"content");
    assert_eq!(root.attachment_revisions().unwrap()["One/scan"], 1);
}

#[test]
#[cfg(unix)]
fn first_read_refuses_if_its_revision_cannot_be_persisted() {
    use std::os::unix::fs::PermissionsExt;

    let (_dir, root, key) = store();
    add(&root, &key, "One/scan", b"content");
    let revisions = root.path.join(ATTACHMENT_REVISION_FILE);
    std::fs::remove_file(&revisions).unwrap();
    std::fs::set_permissions(&root.path, std::fs::Permissions::from_mode(0o500)).unwrap();
    // A privileged process can bypass chmod, so verify this fixture can
    // actually simulate the write failure before asserting on the result.
    let probe = root.path.join("permission-probe");
    if std::fs::write(&probe, b"").is_ok() {
        std::fs::remove_file(probe).unwrap();
        std::fs::set_permissions(&root.path, std::fs::Permissions::from_mode(0o700)).unwrap();
        return;
    }
    let mut output = Vec::new();
    let result = root.attach_get("One/scan", &mut output, &key);
    std::fs::set_permissions(&root.path, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(result.is_err());
    assert!(output.is_empty());
    assert!(!revisions.exists());
    assert_eq!(get(&root, &key, "One/scan").unwrap(), b"content");
}

#[test]
fn listing_and_locked_garbage_collection_initialize_missing_counters() {
    let (_dir, root, key) = store();
    add(&root, &key, "One/scan", b"first");
    add(&root, &key, "Two/scan", b"second");
    let revisions = root.path.join(ATTACHMENT_REVISION_FILE);
    std::fs::remove_file(&revisions).unwrap();
    assert_eq!(root.attach_ls(None, &key).unwrap().len(), 2);
    assert_eq!(root.attachment_revisions().unwrap().len(), 2);

    // GC already holds the exclusive lock: first reads within it must not
    // attempt to reacquire the lock or silently skip the initial counters.
    std::fs::remove_file(revisions).unwrap();
    root.attach_gc(&key).unwrap();
    assert_eq!(root.attachment_revisions().unwrap().len(), 2);
}

#[test]
fn removal_tombstone_survives_fresh_clone_and_interrupted_unlink() {
    let (_dir, root, key) = store();
    add(&root, &key, "One/scan", b"first");
    let rel = attach_relative("One/scan").unwrap();
    let old = confined_read(&root.path, &rel).unwrap();
    // Model a clone, where the local map is not tracked in Git.
    std::fs::remove_file(root.path.join(ATTACHMENT_REVISION_FILE)).unwrap();
    // Model a stop after the tombstone but before the manifest unlink.
    assert_eq!(
        root.next_attachment_revision("One/scan", &key, None)
            .unwrap(),
        2
    );
    assert!(get(&root, &key, "One/scan").is_err());
    root.attach_rm("One/scan", &key).unwrap();
    assert_eq!(root.attachment_revisions().unwrap()["One/scan"], 3);
    confined_write(&root.path, &rel, &old).unwrap();
    assert!(get(&root, &key, "One/scan").is_err());
}

#[test]
fn removal_does_not_wrap_an_exhausted_attachment_revision() {
    let (_dir, root, key) = store();
    add(&root, &key, "One/scan", b"first");
    root.record_attachment_revision("One/scan", u64::MAX)
        .unwrap();
    let rel = attach_relative("One/scan").unwrap();
    let old = confined_read(&root.path, &rel).unwrap();
    assert!(root.attach_rm("One/scan", &key).is_err());
    assert_eq!(confined_read(&root.path, &rel).unwrap(), old);
}

#[test]
fn removal_without_a_counter_refuses_a_malformed_manifest() {
    let (_dir, root, key) = store();
    add(&root, &key, "One/scan", b"first");
    let rel = attach_relative("One/scan").unwrap();
    std::fs::remove_file(root.path.join(ATTACHMENT_REVISION_FILE)).unwrap();
    confined_write(&root.path, &rel, b"corrupt").unwrap();
    assert!(root.attach_rm("One/scan", &key).is_err());
    assert_eq!(confined_read(&root.path, &rel).unwrap(), b"corrupt");
}

#[test]
fn attachment_whitespace_aliases_share_a_removal_tombstone() {
    let (_dir, root, key) = store();
    add(&root, &key, "  One/scan  ", b"first");
    let rel = attach_relative("One/scan").unwrap();
    let old = confined_read(&root.path, &rel).unwrap();
    assert_eq!(get(&root, &key, "  One/scan  ").unwrap(), b"first");
    root.attach_rm("One/scan", &key).unwrap();
    confined_write(&root.path, &rel, &old).unwrap();
    assert!(get(&root, &key, "  One/scan  ").is_err());

    std::fs::remove_file(root.path.join(ATTACHMENT_REVISION_FILE)).unwrap();
    root.attach_rm("One/scan", &key).unwrap();
    confined_write(&root.path, &rel, &old).unwrap();
    assert!(get(&root, &key, "  One/scan  ").is_err());
}

#[test]
fn explicit_recovery_preserves_an_interrupted_non_git_attachment() {
    let (_dir, root, key) = store();
    add(&root, &key, "One/scan", b"first");
    let rel = attach_relative("One/scan").unwrap();
    let old = confined_read(&root.path, &rel).unwrap();
    root.next_attachment_revision("One/scan", &key, None)
        .unwrap();
    assert!(get(&root, &key, "One/scan").is_err());
    assert!(root
        .recover_attachment_trusting_ciphertext("One/scan", &ItemDataKey::generate())
        .is_err());
    assert_eq!(confined_read(&root.path, &rel).unwrap(), old);
    assert_eq!(root.attachment_revisions().unwrap()["One/scan"], 2);

    root.recover_attachment_trusting_ciphertext("One/scan", &key)
        .unwrap();
    assert_eq!(root.attachment_revisions().unwrap()["One/scan"], 3);
    assert_eq!(get(&root, &key, "One/scan").unwrap(), b"first");
    confined_write(&root.path, &rel, &old).unwrap();
    assert!(get(&root, &key, "One/scan").is_err());
}

#[test]
fn interrupted_new_attachment_can_be_replaced_from_its_source() {
    let (_dir, root, key) = store();
    root.attachment_witness_ready(&key).unwrap();
    let path = root.path.join(attach_relative("One/scan").unwrap());
    root.advance_attachment_witness("One/scan", &path, &key, 0, None)
        .unwrap();
    assert!(root.attach_ls(None, &key).is_err());
    assert!(root.attach_gc(&key).is_err());
    add(&root, &key, "One/scan", b"recovered from source");
    assert_eq!(
        get(&root, &key, "One/scan").unwrap(),
        b"recovered from source"
    );
    assert_eq!(root.attach_ls(None, &key).unwrap().len(), 1);
}
