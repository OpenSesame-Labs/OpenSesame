use super::*;
use crate::{init_store, Entry, ItemDataKey};
use std::process::Command;

fn git_init(dir: &Path) {
    let init = Command::new(crate::git_exec::git_program_for_tests())
        .args(["init"])
        .current_dir(dir)
        .status()
        .unwrap();
    assert!(init.success());
    let _ = Command::new(crate::git_exec::git_program_for_tests())
        .args(["config", "user.email", "test@example.com"])
        .current_dir(dir)
        .status();
    let _ = Command::new(crate::git_exec::git_program_for_tests())
        .args(["config", "user.name", "Test"])
        .current_dir(dir)
        .status();
}

fn tracked_files(dir: &Path) -> String {
    let tree = Command::new(crate::git_exec::git_program_for_tests())
        .args([
            "-C",
            dir.to_str().unwrap(),
            "ls-tree",
            "-r",
            "--name-only",
            "HEAD",
        ])
        .output()
        .unwrap();
    String::from_utf8_lossy(&tree.stdout).into_owned()
}

fn git_output(dir: &Path, args: &[&str]) -> String {
    let output = Command::new(crate::git_exec::git_program_for_tests())
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout).unwrap()
}

#[test]
fn auto_commit_preserves_unrelated_staged_plaintext_and_skips_noop() {
    let dir = tempfile::tempdir().unwrap();
    git_init(dir.path());
    let root = init_store(dir.path(), &[]).unwrap();
    std::fs::write(dir.path().join("private.txt"), b"fixture").unwrap();
    assert!(Command::new(crate::git_exec::git_program_for_tests())
        .args(["add", "private.txt"])
        .current_dir(dir.path())
        .status()
        .unwrap()
        .success());
    let key = ItemDataKey::generate();
    root.insert("Dev/[literal]", &Entry::parse("secret"), &key)
        .unwrap();
    let tracked = tracked_files(dir.path());
    assert!(tracked.contains("Dev/[literal].osseal"), "{tracked}");
    assert!(!tracked.contains("private.txt"), "{tracked}");
    assert!(git_output(dir.path(), &["diff", "--cached", "--name-only"]).contains("private.txt"));

    let before = git_output(dir.path(), &["rev-parse", "HEAD"]);
    auto_commit(dir.path(), "no selected changes").unwrap();
    assert_eq!(git_output(dir.path(), &["rev-parse", "HEAD"]), before);
    assert!(git_output(dir.path(), &["diff", "--cached", "--name-only"]).contains("private.txt"));
}

#[test]
fn auto_commit_limits_large_path_sets_and_handles_tracked_deletions() {
    let dir = tempfile::tempdir().unwrap();
    git_init(dir.path());
    std::fs::create_dir(dir.path().join("bulk")).unwrap();
    std::fs::write(dir.path().join("private.txt"), b"fixture").unwrap();
    assert!(Command::new(crate::git_exec::git_program_for_tests())
        .args(["add", "private.txt"])
        .current_dir(dir.path())
        .status()
        .unwrap()
        .success());
    for index in 0..220 {
        std::fs::write(
            dir.path().join(format!("bulk/item-{index:03}.osseal")),
            b"sealed",
        )
        .unwrap();
    }
    auto_commit(dir.path(), "sealed fixture").unwrap();
    assert!(!tracked_files(dir.path()).contains("private.txt"));
    for index in 0..110 {
        std::fs::remove_file(dir.path().join(format!("bulk/item-{index:03}.osseal"))).unwrap();
    }
    auto_commit(dir.path(), "remove sealed fixture").unwrap();
    let tracked = tracked_files(dir.path());
    assert!(!tracked.contains("bulk/item-000.osseal"));
    assert!(tracked.contains("bulk/item-219.osseal"));
    assert!(!tracked.contains("private.txt"));
    assert!(git_output(dir.path(), &["diff", "--cached", "--name-only"]).contains("private.txt"));
}

#[test]
fn auto_commit_records_insert() {
    let dir = tempfile::tempdir().unwrap();
    git_init(dir.path());

    let root = init_store(dir.path(), &[]).unwrap();
    std::fs::write(dir.path().join("manifest.json"), r#"[{"secret":"leak"}]"#).unwrap();
    let key = ItemDataKey::generate();
    root.insert(
        "a",
        &Entry {
            secret: "x".into(),
            trailer: String::new(),
            otp: None,
        },
        &key,
    )
    .unwrap();
    let log = Command::new(crate::git_exec::git_program_for_tests())
        .args([
            "-C",
            dir.path().to_str().unwrap(),
            "log",
            "-1",
            "--pretty=%s",
        ])
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&log.stdout).contains(crate::store::COMMIT_ADD));
    assert!(!tracked_files(dir.path()).contains("manifest.json"));
}

#[test]
fn attachment_ciphertext_is_committed_but_local_state_is_not() {
    let dir = tempfile::tempdir().unwrap();
    git_init(dir.path());
    init_store(dir.path(), &[]).unwrap();

    // Stand in for what an attachment writes: a manifest, a chunk object,
    // and the local-only revision map.
    std::fs::create_dir_all(dir.path().join(".attachments/objects/ab")).unwrap();
    std::fs::create_dir_all(dir.path().join("Taxes")).unwrap();
    std::fs::write(dir.path().join("Taxes/w2.osattach"), b"sealed manifest").unwrap();
    std::fs::write(
        dir.path().join(".attachments/objects/ab/abcd.oschunk"),
        b"sealed chunk",
    )
    .unwrap();
    std::fs::write(
        dir.path().join(".opensesame-attachment-revisions.json"),
        b"{}",
    )
    .unwrap();

    auto_commit(dir.path(), crate::store::COMMIT_ATTACH).unwrap();
    let tracked = tracked_files(dir.path());
    assert!(tracked.contains("Taxes/w2.osattach"), "{tracked}");
    assert!(tracked.contains("abcd.oschunk"), "{tracked}");
    assert!(
        !tracked.contains("attachment-revisions"),
        "anti-rollback state is local-only: {tracked}"
    );
}

#[test]
fn remote_round_trip_and_autopush_flag() {
    let dir = tempfile::tempdir().unwrap();
    git_init(dir.path());
    assert!(remote_url(dir.path()).is_none());
    set_remote(dir.path(), "https://github.com/example/store.git").unwrap();
    assert_eq!(
        remote_url(dir.path()).as_deref(),
        Some("https://github.com/example/store.git")
    );
    // set-url path
    set_remote(dir.path(), "https://github.com/example/other.git").unwrap();
    assert_eq!(
        remote_url(dir.path()).as_deref(),
        Some("https://github.com/example/other.git")
    );
    assert!(!auto_push_enabled(dir.path()));
    set_auto_push(dir.path(), true).unwrap();
    assert!(auto_push_enabled(dir.path()));
    set_auto_push(dir.path(), false).unwrap();
    assert!(!auto_push_enabled(dir.path()));
}

#[test]
fn push_backup_to_local_bare_remote() {
    let store = tempfile::tempdir().unwrap();
    let bare = tempfile::tempdir().unwrap();
    assert!(Command::new(crate::git_exec::git_program_for_tests())
        .args(["init", "--bare"])
        .current_dir(bare.path())
        .status()
        .unwrap()
        .success());
    git_init(store.path());
    let root = init_store(store.path(), &[]).unwrap();
    let key = ItemDataKey::generate();
    root.insert(
        "b",
        &Entry {
            secret: "y".into(),
            trailer: String::new(),
            otp: None,
        },
        &key,
    )
    .unwrap();
    set_remote(store.path(), bare.path().to_str().unwrap()).unwrap();
    push_backup(store.path(), None).unwrap();
    let log = Command::new(crate::git_exec::git_program_for_tests())
        .args(["log", "-1", "--pretty=%s"])
        .current_dir(bare.path())
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&log.stdout).contains(crate::store::COMMIT_ADD));
}

#[test]
fn push_backup_without_remote_names_the_fix() {
    let dir = tempfile::tempdir().unwrap();
    git_init(dir.path());
    let err = push_backup(dir.path(), None).unwrap_err();
    assert!(err.to_string().contains("--remote"));
}

/// A backup remote carries the whole commit history. Entry names in subjects
/// would publish the folder tree beside ciphertext that never opened.
#[test]
fn commit_subjects_never_name_the_entry() {
    let dir = tempfile::tempdir().unwrap();
    let root = init_store(dir.path(), &[]).unwrap();
    ensure_git_repo(dir.path()).unwrap();
    let key = ItemDataKey::generate();
    let planted = "XZQPLANTED/api-token";
    let entry = |secret: &str| Entry {
        secret: secret.into(),
        trailer: String::new(),
        otp: None,
    };

    root.insert(planted, &entry("first"), &key).unwrap();
    root.insert_or_replace(planted, &entry("second"), &key)
        .unwrap();
    root.rm_with_key(planted, &key).unwrap();

    let log = Command::new("git")
        .args(["log", "--format=%B"])
        .current_dir(dir.path())
        .output()
        .unwrap();
    let subjects = String::from_utf8(log.stdout).unwrap();
    assert!(!subjects.contains("XZQPLANTED"), "{subjects}");
    assert!(!subjects.contains("api-token"), "{subjects}");
    assert!(subjects.contains(crate::store::COMMIT_ADD));
    assert!(subjects.contains(crate::store::COMMIT_EDIT));
    assert!(subjects.contains(crate::store::COMMIT_REMOVE));
    assert_eq!(crate::store::COMMIT_RESTORE, "seal: restore entry");
}

#[cfg(unix)]
#[test]
fn the_push_token_never_reaches_the_persons_own_credential_helpers() {
    use std::io::Write as _;
    use std::process::Stdio;
    // A person who keeps `credential.helper=store`: git hands a credential it
    // was given to every helper once it works, so the token would be written
    // to ~/.git-credentials in plaintext.
    const TOKEN: &str = "vtok_dummy_push_0123456789abcdef";
    let home = tempfile::tempdir().unwrap();
    std::fs::write(
        home.path().join(".gitconfig"),
        "[credential]\n\thelper = store\n",
    )
    .unwrap();
    let mut lookup = crate::git_exec::captured_lookup();
    lookup.vars.retain(|(name, _)| name != "XDG_CONFIG_HOME");
    lookup.vars.retain(|(name, _)| name != "HOME");
    lookup.vars.push(("HOME".into(), home.path().into()));
    let git_credential = |verb: &str, input: &str| {
        let mut cmd = authenticated_git_in(&lookup, Some(TOKEN)).unwrap();
        let mut child = cmd
            .args(["credential", verb])
            // Only this private home's global helper participates in the fixture.
            .current_dir(home.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(
            out.status.success(),
            "{verb}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap()
    };
    let filled = git_credential("fill", "protocol=https\nhost=example.invalid\n\n");
    assert!(
        filled.contains(TOKEN),
        "our helper did not answer: {filled}"
    );
    git_credential("approve", &filled);
    let stored = home.path().join(".git-credentials");
    assert!(
        !stored.exists(),
        "the push token was stored by the person's own helper"
    );
}
