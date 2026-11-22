//! Authored real Windows file/ACL checks; no hosted execution is claimed here.

use super::*;
use std::{
    fs,
    os::windows::fs::OpenOptionsExt,
    process::{Command, Stdio},
    sync::Arc,
};
use windows_sys::Win32::Storage::FileSystem::CreateDirectoryW;

fn private_root(parent: &Path) -> std::path::PathBuf {
    let root = parent.join("private-root");
    let descriptor = security::Descriptor::private(&security::owner_sid().unwrap(), true).unwrap();
    let attributes = descriptor.attributes().unwrap();
    let path = handles::wide(&root).unwrap();
    // SAFETY: controlled terminated fixture path and private descriptor stay owned.
    assert_ne!(
        unsafe { CreateDirectoryW(path.as_ptr(), &raw const attributes) },
        0
    );
    root
}

fn public_read(path: &Path) {
    let status = Command::new("icacls.exe")
        .arg(path)
        .args(["/grant", "*S-1-1-0:(RX)"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "real fixture ACL modification failed");
}

#[test]
fn a_stream_is_private_before_its_first_byte_and_publishes_only_under_the_pinned_root() {
    let temp = tempfile::tempdir().unwrap();
    let root = private_root(temp.path());
    let held = PrivateDirectory::open(&root).unwrap();
    let name = Path::new("key.pem");
    atomic_write_with(&held, name, |file| {
        security::verify(file, &held.owner, false)?;
        assert_eq!(file.metadata()?.len(), 0);
        assert!(fs::rename(&root, temp.path().join("moved")).is_err());
        file.write_all(b"private material")
    })
    .unwrap();
    assert_eq!(fs::read(root.join(name)).unwrap(), b"private material");
    let file = File::open(root.join(name)).unwrap();
    security::verify(&file, &held.owner, false).unwrap();
    drop(file);
    public_read(&root.join(name));
    atomic_write(&held, name, b"replacement private material").unwrap();
    let file = File::open(root.join(name)).unwrap();
    security::verify(&file, &held.owner, false).unwrap();
    assert_eq!(
        fs::read(root.join(name)).unwrap(),
        b"replacement private material"
    );
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
}

#[test]
fn fill_failure_preserves_the_complete_destination_and_cleans_the_exact_pending_file() {
    let temp = tempfile::tempdir().unwrap();
    let root = private_root(temp.path());
    let held = PrivateDirectory::open(&root).unwrap();
    let name = Path::new("session.json");
    atomic_write(&held, name, b"complete previous").unwrap();
    let result = atomic_write_with(&held, name, |file| {
        file.write_all(b"partial replacement")?;
        Err(io::Error::other("actual producer callback failure"))
    });
    assert!(result.is_err());
    assert_eq!(fs::read(root.join(name)).unwrap(), b"complete previous");
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
}

#[test]
fn kernel_sharing_refusal_preserves_the_destination_and_cleans_private_pending_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let root = private_root(temp.path());
    let held = PrivateDirectory::open(&root).unwrap();
    let name = Path::new("key.pem");
    atomic_write(&held, name, b"complete previous").unwrap();
    let blocker = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(root.join(name))
        .unwrap();
    assert!(atomic_write(&held, name, b"complete replacement").is_err());
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    drop(blocker);
    assert_eq!(fs::read(root.join(name)).unwrap(), b"complete previous");
    atomic_write(&held, name, b"complete replacement").unwrap();
    assert_eq!(fs::read(root.join(name)).unwrap(), b"complete replacement");
}

#[test]
fn actual_root_acl_widening_during_fill_refuses_publication_and_preserves_old_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let root = private_root(temp.path());
    let held = PrivateDirectory::open(&root).unwrap();
    let name = Path::new("key.pem");
    atomic_write(&held, name, b"complete previous").unwrap();
    assert!(atomic_write_with(&held, name, |file| {
        file.write_all(b"private pending bytes")?;
        public_read(&root);
        Ok(())
    })
    .is_err());
    assert_eq!(fs::read(root.join(name)).unwrap(), b"complete previous");
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    assert!(PrivateDirectory::open(&root).is_err());
}

#[test]
fn exclusive_creation_never_overwrites_and_the_completed_file_is_private() {
    let temp = tempfile::tempdir().unwrap();
    let root = private_root(temp.path());
    let held = PrivateDirectory::open(&root).unwrap();
    let name = Path::new("key.pem");
    write_new(&held, name, b"complete original").unwrap();
    assert!(write_new(&held, name, b"replacement").is_err());
    assert_eq!(fs::read(root.join(name)).unwrap(), b"complete original");
    security::verify(&File::open(root.join(name)).unwrap(), &held.owner, false).unwrap();
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
}

#[test]
fn exact_handle_removal_refuses_a_hardlinked_leaf() {
    let temp = tempfile::tempdir().unwrap();
    let root = private_root(temp.path());
    let held = PrivateDirectory::open(&root).unwrap();
    let name = Path::new("checkpoint");
    write_new(&held, name, b"current").unwrap();
    let alias = temp.path().join("outside-alias");
    fs::hard_link(root.join(name), &alias).unwrap();

    assert!(remove_file(&held, name).is_err());
    assert_eq!(fs::read(&alias).unwrap(), b"current");
    assert_eq!(fs::read(root.join(name)).unwrap(), b"current");

    fs::remove_file(alias).unwrap();
    remove_file(&held, name).unwrap();
    assert!(!root.join(name).exists());
}

#[test]
fn confined_legacy_access_accepts_broad_acl_but_keeps_exact_handle_guards() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("legacy-root");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("legacy"), b"legacy bytes").unwrap();
    let held = Arc::new(PrivateDirectory::open_confined(&root).unwrap());

    assert!(HeldPrivateRead::open(Arc::clone(&held), Path::new("legacy"), 4096).is_err());
    let read =
        HeldPrivateRead::open_confined(Arc::clone(&held), Path::new("legacy"), 4096).unwrap();
    assert_eq!(read.bytes(), b"legacy bytes");
    drop(read);

    let alias = temp.path().join("legacy-alias");
    fs::hard_link(root.join("legacy"), &alias).unwrap();
    assert!(remove_confined_file(&held, Path::new("legacy")).is_err());
    fs::remove_file(alias).unwrap();
    remove_confined_file(&held, Path::new("legacy")).unwrap();

    fs::write(root.join("replace"), b"broad old bytes").unwrap();
    atomic_write(&held, Path::new("replace"), b"private replacement").unwrap();
    let replaced = File::open(root.join("replace")).unwrap();
    security::verify(&replaced, &held.owner, false).unwrap();
}

#[test]
fn unsafe_leaf_names_and_hardlinked_destinations_refuse_without_modifying_outside_objects() {
    let temp = tempfile::tempdir().unwrap();
    let root = private_root(temp.path());
    let held = PrivateDirectory::open(&root).unwrap();
    for name in [
        r"..\outside.pem",
        r"C:\outside.pem",
        r"C:relative",
        "NUL",
        "file:stream",
        "trailing.",
    ] {
        assert!(atomic_write(&held, Path::new(name), b"new private bytes").is_err());
        assert!(write_new(&held, Path::new(name), b"new private bytes").is_err());
    }
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    let name = Path::new("key.pem");
    atomic_write(&held, name, b"complete original").unwrap();
    let alias = temp.path().join("outside-alias.pem");
    fs::hard_link(root.join(name), &alias).unwrap();
    assert!(atomic_write(&held, name, b"replacement").is_err());
    assert_eq!(fs::read(&alias).unwrap(), b"complete original");
    assert_eq!(fs::read(root.join(name)).unwrap(), b"complete original");
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
}

#[test]
fn junction_roots_refuse_before_any_outside_file_is_created() {
    let temp = tempfile::tempdir().unwrap();
    let root = private_root(temp.path());
    let junction = temp.path().join("redirect");
    let status = Command::new("cmd.exe")
        .args(["/D", "/C", "mklink", "/J"])
        .arg(&junction)
        .arg(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "real junction fixture creation failed");
    assert!(PrivateDirectory::open(&junction).is_err());
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    let held = PrivateDirectory::open(&root).unwrap();
    write_new(&held, Path::new("positive.pem"), b"controlled positive").unwrap();
    assert_eq!(
        fs::read(root.join("positive.pem")).unwrap(),
        b"controlled positive"
    );
    fs::remove_dir(&junction).unwrap();
}
