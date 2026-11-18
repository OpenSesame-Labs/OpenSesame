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
fn removal_tombstone_survives_fresh_clone_and_interrupted_unlink() {
    let (_dir, root, key) = store();
    add(&root, &key, "One/scan", b"first");
    let rel = attach_relative("One/scan").unwrap();
    let old = confined_read(&root.path, &rel).unwrap();
    // Model a clone, where the local map is not tracked in Git.
    std::fs::remove_file(root.path.join(ATTACHMENT_REVISION_FILE)).unwrap();
    // Model a stop after the tombstone but before the manifest unlink.
    assert_eq!(root.next_attachment_revision("One/scan").unwrap(), 2);
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
    root.next_attachment_revision("One/scan").unwrap();
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
