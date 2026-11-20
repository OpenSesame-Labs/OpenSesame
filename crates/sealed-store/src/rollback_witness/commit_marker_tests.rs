use super::*;
use crate::envelope::{seal_osseal, seal_osseal_in};
use crate::path::confined_atomic_write;
use crate::{init_store, init_store_key, AttachMeta, Entry};

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

fn slot_for(epoch: u64) -> &'static str {
    if epoch.is_multiple_of(2) {
        SLOT_TWO
    } else {
        SLOT_ONE
    }
}

fn stage_witness(store: &StoreRoot, id: &str, key: &ItemDataKey, witness: &Witness, slot: &str) {
    let plaintext = serde_json::to_vec(witness).unwrap();
    let sealed = seal_osseal_in(COLLECTION, &plaintext, key, id, witness.epoch).unwrap();
    store.write_witness_slot(id, slot, &sealed).unwrap();
}

fn remove_marker(store: &StoreRoot, id: &str, key: &ItemDataKey) {
    let (root, _) = store.witness_directory(id).unwrap();
    std::fs::remove_file(root.join(StoreRoot::commit_marker_relative(id, key))).unwrap();
}

fn backfill_v1_entry_commitments(store: &StoreRoot, witness: &mut Witness, key: &ItemDataKey) {
    for (name, entry) in witness.entries.iter_mut() {
        if name.starts_with(".attachments/") || entry.deleted || entry.commitment != [0; 32] {
            continue;
        }
        *entry = store
            .migration_entry_witness(name, entry.revision, key)
            .expect("backfill v1 entry commitment");
    }
}

fn make_legacy(store: &StoreRoot, key: &ItemDataKey) -> (String, Witness) {
    let (id, mut legacy) = store.current_witness(key).unwrap();
    legacy.version = 1;
    legacy
        .entries
        .retain(|name, _| !name.starts_with(".attachments/.rollback-"));
    for entry in legacy.entries.values_mut() {
        entry.commitment = [0; 32];
    }
    stage_witness(store, &id, key, &legacy, SLOT_ONE);
    stage_witness(store, &id, key, &legacy, SLOT_TWO);
    remove_marker(store, &id, key);
    (id, legacy)
}

#[test]
fn uncommitted_slot_does_not_advance_the_current_checkpoint() {
    let (_dir, store, key) = seeded();
    let (id, current) = store.current_witness(&key).unwrap();
    let mut prepared = current.clone();
    prepared.epoch += 1;
    prepared.entries.get_mut("Dev/token").unwrap().revision += 1;
    stage_witness(&store, &id, &key, &prepared, slot_for(prepared.epoch));

    assert_eq!(store.current_witness(&key).unwrap().1.epoch, current.epoch);
    assert!(store.show("Dev/token", &key).is_ok());
    assert!(store.attach_get("Docs/file", &mut Vec::new(), &key).is_ok());
    store
        .insert_or_replace("Dev/token", &Entry::parse("new"), &key)
        .unwrap();
    assert_eq!(store.current_witness(&key).unwrap().1.epoch, prepared.epoch);
}

#[test]
fn missing_or_older_committed_slot_cannot_select_previous_state() {
    let (_dir, store, key) = seeded();
    let (id, current) = store.current_witness(&key).unwrap();
    let (root, directory) = store.witness_directory(&id).unwrap();
    let current_slot = root.join(&directory).join(slot_for(current.epoch));
    let older_slot = root.join(&directory).join(slot_for(current.epoch - 1));
    let older = std::fs::read(older_slot).unwrap();
    std::fs::remove_file(&current_slot).unwrap();
    assert!(store.entry_witness("Dev/token", &key).is_err());
    assert!(store.attachment_witness("Docs/file", &key).is_err());
    std::fs::write(current_slot, older).unwrap();
    assert!(store.entry_witness("Dev/token", &key).is_err());
    assert!(store.attachment_witness("Docs/file", &key).is_err());
}

#[test]
fn missing_marker_does_not_bootstrap_a_migrated_checkpoint() {
    let (_dir, store, key) = seeded();
    let (id, _) = store.current_witness(&key).unwrap();
    remove_marker(&store, &id, &key);
    assert!(store.entry_witness("Dev/token", &key).is_err());
    assert!(store.migrate_rollback_anchor(&key).is_err());
}

#[test]
fn committed_witness_ahead_of_ciphertext_requires_explicit_recovery() {
    let (_dir, store, key) = seeded();
    let (id, mut prepared) = store.current_witness(&key).unwrap();
    prepared.epoch += 1;
    prepared.entries.get_mut("Dev/token").unwrap().revision += 1;
    store.write_witness(&id, &key, &prepared).unwrap();
    assert!(store.show("Dev/token", &key).is_err());
    // The unrelated attachment remains readable at its committed revision.
    assert!(store.attach_get("Docs/file", &mut Vec::new(), &key).is_ok());
    store
        .recover_entry_trusting_ciphertext("Dev/token", &key)
        .unwrap();
    assert!(store.show("Dev/token", &key).is_ok());
}

#[test]
fn removal_and_recreation_keep_the_tombstone_high_water_mark() {
    let (dir, store, key) = seeded();
    let path = dir.path().join("Docs/file.osattach");
    let original = std::fs::read(&path).unwrap();
    store.attach_rm("Docs/file", &key).unwrap();
    let deleted = store.attachment_witness("Docs/file", &key).unwrap();
    assert!(deleted.deleted);
    store
        .attach_add(
            "Docs/file",
            &mut std::io::Cursor::new(b"new"),
            3,
            AttachMeta {
                filename: "file".into(),
                mime: None,
            },
            &key,
            false,
        )
        .unwrap();
    let recreated = store.attachment_witness("Docs/file", &key).unwrap();
    assert!(!recreated.deleted);
    assert!(recreated.revision > deleted.revision);
    std::fs::write(path, original).unwrap();
    assert!(store
        .attach_get("Docs/file", &mut Vec::new(), &key)
        .is_err());
}

#[test]
fn version_one_checkpoint_requires_explicit_verified_migration() {
    let (_dir, store, key) = seeded();
    let (_, legacy) = make_legacy(&store, &key);
    assert!(store.show("Dev/token", &key).is_err());
    assert!(store
        .attach_get("Docs/file", &mut Vec::new(), &key)
        .is_err());
    store.migrate_rollback_anchor(&key).unwrap();
    let (_, upgraded) = store.current_witness(&key).unwrap();
    assert_eq!(upgraded.epoch, legacy.epoch + 1);
    assert!(store.show("Dev/token", &key).is_ok());
    let mut contents = Vec::new();
    store.attach_get("Docs/file", &mut contents, &key).unwrap();
    assert_eq!(contents, b"contents");
}

#[test]
fn interrupted_legacy_migration_resumes_only_its_exact_prepared_witness() {
    let (_dir, store, key) = seeded();
    let (id, legacy) = make_legacy(&store, &key);
    let mut prepared = legacy.clone();
    store.anchor_attachments(&mut prepared, &key).unwrap();
    backfill_v1_entry_commitments(&store, &mut prepared, &key);
    prepared.version = 2;
    prepared.epoch += 1;
    stage_witness(&store, &id, &key, &prepared, slot_for(prepared.epoch));
    assert!(store.show("Dev/token", &key).is_err());
    store.migrate_rollback_anchor(&key).unwrap();
    assert_eq!(store.current_witness(&key).unwrap().1.epoch, prepared.epoch);
    assert!(store.attach_get("Docs/file", &mut Vec::new(), &key).is_ok());
}

#[test]
fn changed_legacy_inventory_does_not_replace_a_prepared_migration() {
    let (dir, store, key) = seeded();
    let (id, legacy) = make_legacy(&store, &key);
    let mut prepared = legacy.clone();
    store.anchor_attachments(&mut prepared, &key).unwrap();
    backfill_v1_entry_commitments(&store, &mut prepared, &key);
    prepared.version = 2;
    prepared.epoch += 1;
    stage_witness(&store, &id, &key, &prepared, slot_for(prepared.epoch));
    std::fs::remove_file(dir.path().join("Docs/file.osattach")).unwrap();
    assert!(store.migrate_rollback_anchor(&key).is_err());
    assert!(store.read_commit_marker(&id, &key).unwrap().is_none());
}

#[test]
fn migration_preserves_a_sole_legacy_slot_even_when_parity_disagrees() {
    let (_dir, store, key) = seeded();
    let (id, legacy) = make_legacy(&store, &key);
    let (root, directory) = store.witness_directory(&id).unwrap();
    // Keep the legacy witness in the slot that parity would otherwise select
    // for its successor, as can happen after an interrupted older rekey.
    let successor_slot = slot_for(legacy.epoch + 1);
    let other_slot = if successor_slot == SLOT_ONE {
        SLOT_TWO
    } else {
        SLOT_ONE
    };
    std::fs::remove_file(root.join(directory).join(other_slot)).unwrap();
    let mut prepared = legacy.clone();
    store.anchor_attachments(&mut prepared, &key).unwrap();
    backfill_v1_entry_commitments(&store, &mut prepared, &key);
    prepared.version = 2;
    prepared.epoch += 1;
    let slot = store
        .next_witness_slot(&id, &key, prepared.epoch, Some(&legacy))
        .unwrap();
    assert_eq!(slot, other_slot);
    stage_witness(&store, &id, &key, &prepared, slot);
    store.migrate_rollback_anchor(&key).unwrap();
    assert!(store.show("Dev/token", &key).is_ok());
}

#[test]
fn markerless_migration_fails_closed_when_a_witness_slot_is_unreadable() {
    let (_dir, store, key) = seeded();
    let (id, legacy) = make_legacy(&store, &key);
    // Stage a newer legacy witness in the successor slot, then seal it under a
    // different key as an interrupted rekey leaves behind. The unreadable slot
    // must abort the migration instead of silently migrating from the older
    // legacy witness that remains readable.
    let mut newer = legacy.clone();
    newer.epoch += 1;
    let successor = slot_for(newer.epoch);
    let wrong_key = ItemDataKey::generate();
    let sealed = seal_osseal_in(
        COLLECTION,
        &serde_json::to_vec(&newer).unwrap(),
        &wrong_key,
        &id,
        newer.epoch,
    )
    .unwrap();
    store.write_witness_slot(&id, successor, &sealed).unwrap();
    assert!(store.migrate_rollback_anchor(&key).is_err());
    assert!(store.read_commit_marker(&id, &key).unwrap().is_none());
}

#[test]
fn rekey_retains_the_old_marker_until_the_new_slot_is_committed() {
    let (_dir, store, old_key) = seeded();
    let new_key = ItemDataKey::generate();
    let prepared = store.prepare_witness_rekey(&old_key).unwrap();
    store
        .write_outside_identity_slot(&new_key, &prepared.store_id, IDENTITY_ONE)
        .unwrap();
    assert!(store.entry_witness("Dev/token", &old_key).is_ok());
    assert!(store.entry_witness("Dev/token", &new_key).is_err());

    stage_witness(
        &store,
        &prepared.store_id,
        &new_key,
        &prepared.witness,
        SLOT_ONE,
    );
    assert!(store.entry_witness("Dev/token", &old_key).is_ok());
    assert!(store.entry_witness("Dev/token", &new_key).is_err());
    store
        .write_commit_marker(&prepared.store_id, &new_key, &prepared.witness)
        .unwrap();
    assert!(store.entry_witness("Dev/token", &old_key).is_ok());
    assert!(store.current_witness(&new_key).is_ok());
    assert!(store.entry_witness("Dev/token", &new_key).is_err());
    store.finish_rekeyed_witness(&prepared, &new_key).unwrap();
    assert!(store.entry_witness("Dev/token", &old_key).is_err());
    assert!(store.current_witness(&new_key).is_ok());
    assert!(store.entry_witness("Dev/token", &new_key).is_err());
}

#[test]
fn next_write_preserves_a_sole_rekeyed_slot_before_committing_its_marker() {
    let (_dir, store, old_key) = seeded();
    store
        .insert_or_replace("Dev/token", &Entry::parse("even epoch"), &old_key)
        .unwrap();
    let prepared = store.prepare_witness_rekey(&old_key).unwrap();
    assert!(prepared.witness.epoch.is_multiple_of(2));
    let new_key = ItemDataKey::generate();
    store.write_rekeyed_witness(&prepared, &new_key).unwrap();

    let mut next = prepared.witness.clone();
    next.epoch += 1;
    next.entries.get_mut("Dev/token").unwrap().revision += 1;
    let slot = store
        .next_witness_slot(&prepared.store_id, &new_key, next.epoch, None)
        .unwrap();
    assert_eq!(slot, SLOT_TWO);
    stage_witness(&store, &prepared.store_id, &new_key, &next, slot);
    assert_eq!(
        store.current_witness(&new_key).unwrap().1.epoch,
        prepared.witness.epoch
    );
    store
        .write_commit_marker(&prepared.store_id, &new_key, &next)
        .unwrap();
    assert_eq!(store.current_witness(&new_key).unwrap().1.epoch, next.epoch);
}

fn pre_anchor_store() -> (tempfile::TempDir, StoreRoot, ItemDataKey) {
    let dir = tempfile::tempdir().unwrap();
    let store = init_store(dir.path(), &[]).unwrap();
    let key = init_store_key(dir.path(), b"correct horse").unwrap();
    let rel = StoreRoot::entry_relative("Dev/token", "osseal").unwrap();
    let blob = seal_osseal(b"secret", &key, "Dev/token", 1).unwrap();
    confined_atomic_write(&store.path, &rel, &blob).unwrap();
    store.record_revision("Dev/token", 1).unwrap();
    (dir, store, key)
}

#[test]
fn first_migration_retries_before_identity_publication() {
    let (_dir, store, key) = pre_anchor_store();
    let id = StoreRoot::new_store_id();
    let witness = store.witness_from_current_store(&key).unwrap();
    // A crash after either staging the slot or committing its marker leaves no
    // published identity; a retry independently verifies and anchors the store.
    stage_witness(&store, &id, &key, &witness, slot_for(witness.epoch));
    assert!(store.read_outside_identity(&key).unwrap().is_none());
    store.write_commit_marker(&id, &key, &witness).unwrap();
    store.migrate_rollback_anchor(&key).unwrap();
    assert!(store.show("Dev/token", &key).is_ok());
}

#[test]
fn first_migration_retries_after_one_identity_slot_is_published() {
    let (_dir, store, key) = pre_anchor_store();
    let id = StoreRoot::new_store_id();
    let witness = store.witness_from_current_store(&key).unwrap();
    store.write_witness(&id, &key, &witness).unwrap();
    store
        .write_outside_identity_slot(&key, &id, IDENTITY_ONE)
        .unwrap();
    store.migrate_rollback_anchor(&key).unwrap();
    assert_eq!(store.read_store_id().unwrap(), Some(id.clone()));
    let (root, _) = store.witness_directory(&id).unwrap();
    let identity_dir = std::fs::read_dir(root.join("identities"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    std::fs::remove_file(identity_dir.join(IDENTITY_ONE)).unwrap();
    assert_eq!(
        store.read_outside_identity(&key).unwrap().unwrap().store_id,
        id
    );
    assert!(store.show("Dev/token", &key).is_ok());
}
