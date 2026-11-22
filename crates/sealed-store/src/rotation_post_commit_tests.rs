use super::*;
use crate::{
    init_store, init_store_key, protect_add_store_recovery, unlock_store_key, AttachMeta, Entry,
};
use opensesame_human_vault::root_protection::protect_test_recovery;

#[test]
fn automatic_rotation_reports_when_no_git_repository_exists() {
    let dir = tempfile::tempdir().unwrap();
    init_store(dir.path(), &[]).unwrap();
    let password = b"correct horse";
    init_store_key(dir.path(), password).unwrap();
    let outcome = rotate_store_root(dir.path(), password, RotationEdit::default()).unwrap();
    assert_eq!(
        outcome.git_notice,
        Some(crate::RotationGitNotice::NoRepository)
    );
    assert!(outcome.git_error.is_none());
    assert!(!outcome.git_deferred);
}

#[test]
fn recovery_reissue_defers_git_and_preserves_the_committed_rotation() {
    let dir = tempfile::tempdir().unwrap();
    let store = init_store(dir.path(), &[]).unwrap();
    let password = b"correct horse";
    let old_key = init_store_key(dir.path(), password).unwrap();
    store
        .insert("Dev/token", &Entry::parse("secret"), &old_key)
        .unwrap();
    store
        .attach_add(
            "Docs/file",
            &mut std::io::Cursor::new(b"content"),
            7,
            AttachMeta {
                filename: "file".into(),
                mime: None,
            },
            &old_key,
            false,
        )
        .unwrap();
    let (old_recovery, _) = protect_add_store_recovery(dir.path(), password).unwrap();
    // Git must not run before the one-time keys are returned, even when the
    // repository is invalid.
    std::fs::create_dir(dir.path().join(".git")).unwrap();
    let outcome = rotate_store_root(
        dir.path(),
        password,
        RotationEdit {
            reissue_recovery: true,
            ..RotationEdit::default()
        },
    )
    .unwrap();
    assert!(outcome.git_deferred);
    assert!(outcome.git_error.is_none());
    assert_eq!(outcome.reissued_recovery.len(), 1);
    protect_test_recovery(dir.path(), &outcome.reissued_recovery[0].secret).unwrap();
    assert!(protect_test_recovery(dir.path(), &old_recovery).is_err());
    let current = unlock_store_key(dir.path(), password).unwrap();
    assert_ne!(current.0, old_key.0);
    assert_eq!(store.show("Dev/token", &current).unwrap().secret, "secret");
    assert!(store
        .attach_get("Docs/file", &mut Vec::new(), &current)
        .is_ok());
    assert!(store.show("Dev/token", &old_key).is_err());
    assert!(!dir.path().join(ROTATION_STAGING_DIR).exists());
}

#[cfg(unix)]
#[test]
fn failed_git_commit_is_reported_after_a_rotation_without_reissued_keys() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let store = init_store(dir.path(), &[]).unwrap();
    let password = b"correct horse";
    let old_key = init_store_key(dir.path(), password).unwrap();
    store
        .insert("Dev/token", &Entry::parse("secret"), &old_key)
        .unwrap();
    crate::git::ensure_git_repo(dir.path()).unwrap();
    let hook = dir.path().join(".git/hooks/pre-commit");
    std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
    std::fs::write(&hook, b"#!/bin/sh\n: > .git/hook-was-run\nexit 1\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700)).unwrap();

    let outcome = rotate_store_root(dir.path(), password, RotationEdit::default()).unwrap();
    assert!(dir.path().join(".git/hook-was-run").exists());
    assert!(
        matches!(&outcome.git_error, Some(StoreError::Git(message)) if message == "git commit failed")
    );
    assert!(!outcome.git_deferred);
    assert!(outcome.reissued_recovery.is_empty());
    let current = unlock_store_key(dir.path(), password).unwrap();
    assert_eq!(store.show("Dev/token", &current).unwrap().secret, "secret");
    assert!(store.show("Dev/token", &old_key).is_err());
}

#[cfg(unix)]
#[test]
fn recovery_reissue_returns_before_any_git_hook_runs() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let store = init_store(dir.path(), &[]).unwrap();
    let password = b"correct horse";
    let key = init_store_key(dir.path(), password).unwrap();
    store
        .insert("Dev/token", &Entry::parse("secret"), &key)
        .unwrap();
    protect_add_store_recovery(dir.path(), password).unwrap();
    crate::git::ensure_git_repo(dir.path()).unwrap();
    let hook = dir.path().join(".git/hooks/pre-commit");
    std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
    std::fs::write(&hook, b"#!/bin/sh\n: > .git/hook-was-run\nexit 1\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700)).unwrap();
    let outcome = rotate_store_root(
        dir.path(),
        password,
        RotationEdit {
            reissue_recovery: true,
            ..RotationEdit::default()
        },
    )
    .unwrap();
    assert!(outcome.git_deferred);
    assert!(!dir.path().join(".git/hook-was-run").exists());
    assert_eq!(outcome.reissued_recovery.len(), 1);
    protect_test_recovery(dir.path(), &outcome.reissued_recovery[0].secret).unwrap();
}

#[test]
fn delivery_failure_keeps_the_committed_root_and_recovery_key() {
    let dir = tempfile::tempdir().unwrap();
    let store = init_store(dir.path(), &[]).unwrap();
    let password = b"correct horse";
    let old_key = init_store_key(dir.path(), password).unwrap();
    store
        .insert("Dev/token", &Entry::parse("secret"), &old_key)
        .unwrap();
    protect_add_store_recovery(dir.path(), password).unwrap();
    let mut delivered = None;
    let outcome = crate::rotate_store_root_with_commit(
        dir.path(),
        password,
        RotationEdit {
            reissue_recovery: true,
            ..RotationEdit::default()
        },
        &mut |committed| {
            assert!(dir.path().join(ROTATION_STAGING_DIR).exists());
            let current = unlock_store_key(dir.path(), password).unwrap();
            assert!(store.show("Dev/token", &current).is_err());
            delivered = Some(committed.reissued_recovery[0].secret);
            Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "closed",
            ))
        },
    )
    .unwrap();
    assert!(outcome.delivery_error.is_some());
    assert!(outcome.git_deferred);
    assert!(!dir.path().join(ROTATION_STAGING_DIR).exists());
    let current = unlock_store_key(dir.path(), password).unwrap();
    assert_eq!(store.show("Dev/token", &current).unwrap().secret, "secret");
    protect_test_recovery(dir.path(), &delivered.unwrap()).unwrap();
}

#[test]
fn interrupted_post_commit_delivery_leaves_staging_guard_and_committed_state() {
    let dir = tempfile::tempdir().unwrap();
    let store = init_store(dir.path(), &[]).unwrap();
    let password = b"correct horse";
    let old_key = init_store_key(dir.path(), password).unwrap();
    store
        .insert("Dev/token", &Entry::parse("secret"), &old_key)
        .unwrap();
    protect_add_store_recovery(dir.path(), password).unwrap();
    let mut delivered = None;
    let interrupted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = crate::rotate_store_root_with_commit(
            dir.path(),
            password,
            RotationEdit {
                reissue_recovery: true,
                ..RotationEdit::default()
            },
            &mut |committed| {
                delivered = Some(committed.reissued_recovery[0].secret);
                panic!("simulated interruption after delivery");
            },
        );
    }));
    assert!(interrupted.is_err());
    let staging = dir.path().join(ROTATION_STAGING_DIR);
    assert!(staging.exists());
    let current = unlock_store_key(dir.path(), password).unwrap();
    assert!(store.show("Dev/token", &current).is_err());
    std::fs::remove_dir_all(staging).unwrap();
    assert_eq!(store.show("Dev/token", &current).unwrap().secret, "secret");
    assert!(store.show("Dev/token", &old_key).is_err());
    protect_test_recovery(dir.path(), &delivered.unwrap()).unwrap();
}
