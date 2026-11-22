use super::*;

fn entry(secret: &str) -> Entry {
    Entry {
        secret: secret.into(),
        trailer: String::new(),
        otp: None,
    }
}

#[test]
fn keyless_age_writes_keep_their_format_and_obey_rotation_guards() {
    use age::secrecy::ExposeSecret;

    let dir = tempfile::tempdir().unwrap();
    let root = StoreRoot::open(dir.path()).unwrap();
    let identity = age::x25519::Identity::generate();
    fs::write(
        dir.path().join(".age-recipients"),
        identity.to_public().to_string(),
    )
    .unwrap();
    let entry = Entry::parse("age-secret\n");
    root.insert_or_replace_with_optional_key("entry", &entry, None)
        .unwrap();
    let original = fs::read(dir.path().join("entry.age")).unwrap();
    let identity_text = identity.to_string();
    assert_eq!(
        root.show_with_optional_key("entry", None, Some(identity_text.expose_secret()))
            .unwrap()
            .secret,
        "age-secret"
    );
    fs::create_dir(dir.path().join(crate::rotation::ROTATION_STAGING_DIR)).unwrap();
    assert!(root
        .insert_or_replace_with_optional_key("entry", &entry, None)
        .is_err());
    assert_eq!(fs::read(dir.path().join("entry.age")).unwrap(), original);
    fs::remove_dir(dir.path().join(crate::rotation::ROTATION_STAGING_DIR)).unwrap();
    assert!(root
        .insert_or_replace_with_optional_key(".GIT/entry", &entry, None)
        .is_err());
    fs::write(dir.path().join(".opensesame-recipients"), "").unwrap();
    root.insert_or_replace_with_optional_key("entry", &Entry::parse("updated\n"), None)
        .unwrap();
    assert_eq!(
        root.show_with_optional_key("entry", None, Some(identity_text.expose_secret()))
            .unwrap()
            .secret,
        "updated"
    );
    assert!(!dir.path().join("entry.osseal").exists());
    assert!(root
        .insert_or_replace_with_optional_key("new", &entry, None)
        .is_err());
    let before = fs::read(dir.path().join("entry.age")).unwrap();
    fs::write(
        dir.path().join(KEY_FILE),
        "a key file appeared after opening",
    )
    .unwrap();
    assert!(root
        .insert_or_replace_with_optional_key("entry", &entry, None)
        .is_err());
    assert_eq!(fs::read(dir.path().join("entry.age")).unwrap(), before);
}

#[test]
fn optional_native_key_preserves_age_but_refuses_native_shadow_entries() {
    use age::secrecy::ExposeSecret;

    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let identity = age::x25519::Identity::generate();
    age_fmt::encrypt_age_file(
        &dir.path().join("entry.age"),
        b"age-secret\n",
        &[identity.to_public().to_string()],
    )
    .unwrap();
    let identity_text = identity.to_string();
    let identity_text = Some(identity_text.expose_secret());
    assert_eq!(
        root.show_with_optional_key("entry", None, identity_text)
            .unwrap()
            .secret,
        "age-secret"
    );
    assert!(root.show_with_optional_key("entry", None, None).is_err());
    let blob = seal_osseal(b"injected\n", &ItemDataKey::generate(), "entry", 1).unwrap();
    fs::write(dir.path().join("entry.osseal"), blob).unwrap();
    assert!(matches!(
        root.show_with_optional_key("entry", None, identity_text),
        Err(StoreError::NotInitialized(_))
    ));
    assert!(!dir.path().join(REVISION_FILE).exists());
    fs::remove_file(dir.path().join("entry.osseal")).unwrap();
    assert_eq!(
        root.show_with_optional_key("entry", None, identity_text)
            .unwrap()
            .secret,
        "age-secret"
    );
}

#[test]
fn insert_show_ls_rm() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey::generate();
    root.insert("Dev/token", &entry("abc"), &key).unwrap();
    assert_eq!(root.show("Dev/token", &key).unwrap().secret, "abc");
    assert!(root.ls("Dev").unwrap().iter().any(|n| n.contains("token")));
    root.rm_with_key("Dev/token", &key).unwrap();
    assert!(root.show("Dev/token", &key).is_err());
}

#[test]
fn dotted_names_keep_their_final_label() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey::generate();
    for (name, secret) in [("Email/github.com", "a"), ("Email/github.org", "b")] {
        root.insert(name, &entry(secret), &key).unwrap();
    }
    // Distinct files — `.com` is part of the name, not an extension.
    assert!(dir.path().join("Email/github.com.osseal").exists());
    assert!(dir.path().join("Email/github.org.osseal").exists());
    assert_eq!(root.show("Email/github.com", &key).unwrap().secret, "a");
    assert_eq!(root.show("Email/github.org", &key).unwrap().secret, "b");
    let names = root.ls("Email").unwrap();
    assert!(names.contains(&"Email/github.com".to_string()));
    assert!(names.contains(&"Email/github.org".to_string()));
}

#[test]
fn passphrase_wrap_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &["alice".into()]).unwrap();
    let key = init_store_key(dir.path(), b"correct horse").unwrap();
    root.insert("x", &entry("v"), &key).unwrap();
    let unlocked = unlock_store_key(dir.path(), b"correct horse").unwrap();
    assert_eq!(root.show("x", &unlocked).unwrap().secret, "v");
    assert!(unlock_store_key(dir.path(), b"wrong").is_err());
}

#[test]
fn rejects_ciphertext_moved_to_another_entry() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey::generate();
    for name in ["Dev/a", "Dev/b"] {
        root.insert(name, &entry(name), &key).unwrap();
    }
    fs::copy(
        dir.path().join("Dev/a.osseal"),
        dir.path().join("Dev/b.osseal"),
    )
    .unwrap();
    assert!(root.show("Dev/b", &key).is_err());
}

#[test]
fn rejects_an_older_revision() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey::generate();
    root.insert("Dev/a", &entry("one"), &key).unwrap();
    let old = fs::read(dir.path().join("Dev/a.osseal")).unwrap();
    root.insert_or_replace("Dev/a", &entry("two"), &key)
        .unwrap();
    fs::write(dir.path().join("Dev/a.osseal"), old).unwrap();
    assert!(root.show("Dev/a", &key).is_err());
}

#[test]
fn outside_witness_rejects_blob_and_sidecar_rollback() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey::generate();
    root.insert("Dev/a", &entry("one"), &key).unwrap();
    let old_blob = fs::read(dir.path().join("Dev/a.osseal")).unwrap();
    let old_sidecar = fs::read(dir.path().join(".opensesame-revisions.json")).unwrap();
    root.insert_or_replace("Dev/a", &entry("two"), &key)
        .unwrap();

    fs::write(dir.path().join("Dev/a.osseal"), &old_blob).unwrap();
    fs::remove_file(dir.path().join(".opensesame-revisions.json")).unwrap();
    assert!(root.show("Dev/a", &key).is_err());

    fs::write(dir.path().join(".opensesame-revisions.json"), old_sidecar).unwrap();
    assert!(root.show("Dev/a", &key).is_err());
}

#[test]
fn outside_identity_rejects_rollback_when_in_store_identity_is_missing_or_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey::generate();
    root.insert("Dev/a", &Entry::parse("one\n"), &key).unwrap();
    let old_blob = fs::read(dir.path().join("Dev/a.osseal")).unwrap();
    let old_sidecar = fs::read(dir.path().join(".opensesame-revisions.json")).unwrap();
    root.insert_or_replace("Dev/a", &Entry::parse("two\n"), &key)
        .unwrap();

    fs::write(dir.path().join("Dev/a.osseal"), &old_blob).unwrap();
    fs::write(dir.path().join(".opensesame-revisions.json"), &old_sidecar).unwrap();
    fs::remove_file(dir.path().join(".opensesame-store-id")).unwrap();
    assert!(root.show("Dev/a", &key).is_err());

    fs::write(
        dir.path().join(".opensesame-store-id"),
        b"00000000000000000000000000000000",
    )
    .unwrap();
    assert!(root.show("Dev/a", &key).is_err());
}

#[test]
fn existing_store_needs_explicit_one_time_anchor_migration() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey::generate();
    fs::create_dir(dir.path().join("Dev")).unwrap();
    let blob = crate::envelope::seal_osseal(b"legacy-current\n", &key, "Dev/a", 1).unwrap();
    fs::write(dir.path().join("Dev/a.osseal"), blob).unwrap();
    root.record_revision("Dev/a", 1).unwrap();

    assert!(root.show("Dev/a", &key).is_err());
    root.migrate_rollback_anchor(&key).unwrap();
    assert_eq!(root.show("Dev/a", &key).unwrap().secret, "legacy-current");

    assert!(root.migrate_rollback_anchor(&key).is_err());
}

#[test]
fn anchor_migration_rejects_sidecar_ciphertext_revision_mismatch() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey::generate();
    fs::create_dir(dir.path().join("Dev")).unwrap();
    let blob = crate::envelope::seal_osseal(b"old\n", &key, "Dev/a", 1).unwrap();
    fs::write(dir.path().join("Dev/a.osseal"), blob).unwrap();
    root.record_revision("Dev/a", 2).unwrap();

    assert!(root.migrate_rollback_anchor(&key).is_err());
    assert!(!dir.path().join(".opensesame-store-id").exists());
}

#[test]
fn anchor_migration_does_not_skip_dot_named_ciphertext_without_state() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey::generate();
    fs::create_dir(dir.path().join(".hidden")).unwrap();
    let blob = crate::envelope::seal_osseal(b"dot\n", &key, ".hidden/a", 1).unwrap();
    fs::write(dir.path().join(".hidden/a.osseal"), blob).unwrap();

    assert!(root.migrate_rollback_anchor(&key).is_err());
    assert!(!dir.path().join(".opensesame-store-id").exists());
}

#[test]
fn anchor_migration_refuses_a_stale_root_key_even_for_an_empty_store() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    init_store_key(dir.path(), b"current passphrase").unwrap();
    let stale = ItemDataKey::generate();

    assert!(root.migrate_rollback_anchor(&stale).is_err());
    assert!(!dir.path().join(".opensesame-store-id").exists());
}

#[cfg(unix)]
#[test]
fn outside_witness_root_is_private_and_existing_permissions_are_hardened() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey::generate();
    root.insert("Dev/a", &Entry::parse("one\n"), &key).unwrap();
    let witness_root = root.witness_root().unwrap();
    assert_eq!(
        fs::metadata(&witness_root).unwrap().permissions().mode() & 0o777,
        0o700
    );

    fs::set_permissions(&witness_root, fs::Permissions::from_mode(0o777)).unwrap();
    root.show("Dev/a", &key).unwrap();
    assert_eq!(
        fs::metadata(witness_root).unwrap().permissions().mode() & 0o777,
        0o700
    );
}

#[test]
fn deletion_tombstone_survives_store_root_restore() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey::generate();
    root.insert("Dev/a", &Entry::parse("one\n"), &key).unwrap();
    let blob = fs::read(dir.path().join("Dev/a.osseal")).unwrap();
    let sidecar = fs::read(dir.path().join(".opensesame-revisions.json")).unwrap();
    root.rm_with_key("Dev/a", &key).unwrap();

    fs::write(dir.path().join("Dev/a.osseal"), blob).unwrap();
    fs::write(dir.path().join(".opensesame-revisions.json"), sidecar).unwrap();
    fs::remove_file(dir.path().join(".opensesame-store-id")).unwrap();
    assert!(matches!(
        root.show("Dev/a", &key),
        Err(StoreError::NotFound(_))
    ));
}

#[test]
fn tombstone_before_unlink_is_safe_and_retryable() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey::generate();
    root.insert("Dev/a", &Entry::parse("one\n"), &key).unwrap();

    root.tombstone_entry("Dev/a", &key).unwrap();
    assert!(dir.path().join("Dev/a.osseal").exists());
    assert!(matches!(
        root.show("Dev/a", &key),
        Err(StoreError::NotFound(_))
    ));
    root.rm_with_key("Dev/a", &key).unwrap();
    assert!(!dir.path().join("Dev/a.osseal").exists());
}

#[cfg(unix)]
#[test]
fn refuses_intermediate_and_final_symlinks() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    let key = ItemDataKey::generate();
    let entry = entry("never outside");

    symlink(outside.path(), dir.path().join("Dev")).unwrap();
    assert!(root.insert("Dev/token", &entry, &key).is_err());
    assert!(!outside.path().join("token.osseal").exists());

    fs::remove_file(dir.path().join("Dev")).unwrap();
    fs::create_dir(dir.path().join("Dev")).unwrap();
    symlink(
        outside.path().join("target"),
        dir.path().join("Dev/token.osseal"),
    )
    .unwrap();
    assert!(root.insert("Dev/token", &entry, &key).is_err());
    assert!(!outside.path().join("target").exists());

    fs::write(outside.path().join("planted"), b"outside").unwrap();
    let alias_parent = tempfile::tempdir().unwrap();
    let alias = alias_parent.path().join("root");
    symlink(outside.path(), &alias).unwrap();
    assert!(crate::path::confined_read(&alias, std::path::Path::new("planted")).is_err());
}
