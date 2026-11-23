use super::entry_commitment::entry_matches;
use crate::envelope::{open_osseal_for_path, seal_osseal};
use crate::store::{init_store, init_store_key};
use crate::{Entry, StoreRoot};

#[test]
fn same_revision_forked_entry_fails_witness_check() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = init_store_key(dir.path(), b"correct horse").unwrap();
    root.insert("Dev/token", &Entry::parse("alpha"), &key)
        .unwrap();
    let rel = StoreRoot::entry_relative("Dev/token", "osseal").unwrap();
    let path = dir.path().join(&rel);
    let original = std::fs::read(&path).unwrap();
    let witnessed = root.entry_witness("Dev/token", &key).unwrap();
    let _opened =
        open_osseal_for_path(&original, &key, "Dev/token", Some(witnessed.revision)).unwrap();
    let fork_plaintext = Entry::parse("beta").render().into_bytes();
    let forked = seal_osseal(&fork_plaintext, &key, "Dev/token", witnessed.revision).unwrap();
    std::fs::write(&path, &forked).unwrap();
    assert!(root.show("Dev/token", &key).is_err());
    assert!(!entry_matches(&witnessed, &fork_plaintext));
    std::fs::write(&path, original).unwrap();
    assert!(root.show("Dev/token", &key).is_ok());
}

#[test]
fn trusted_recovery_rebinds_forked_entry() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = init_store_key(dir.path(), b"correct horse").unwrap();
    root.insert("Dev/token", &Entry::parse("alpha"), &key)
        .unwrap();
    let rel = StoreRoot::entry_relative("Dev/token", "osseal").unwrap();
    let path = dir.path().join(&rel);
    let original = std::fs::read(&path).unwrap();
    let witnessed = root.entry_witness("Dev/token", &key).unwrap();
    let fork_plaintext = Entry::parse("beta").render().into_bytes();
    let forked = seal_osseal(&fork_plaintext, &key, "Dev/token", witnessed.revision).unwrap();
    std::fs::write(&path, &forked).unwrap();
    assert!(root.entry_witness("Dev/token", &key).is_err());
    root.recover_entry_trusting_ciphertext("Dev/token", &key)
        .unwrap();
    let rebound = root.entry_witness("Dev/token", &key).unwrap();
    assert!(rebound.revision > witnessed.revision);
    assert_eq!(
        rebound.commitment,
        *blake3::hash(&fork_plaintext).as_bytes()
    );
    assert_eq!(root.show("Dev/token", &key).unwrap().secret, "beta");
    std::fs::write(&path, original).unwrap();
    assert!(root.show("Dev/token", &key).is_err());
}
