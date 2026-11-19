//! Confined atomic replacement for store metadata.

use crate::StoreError;
use std::path::Path;

#[cfg(unix)]
use super::confined::open_parent;
#[cfg(unix)]
use std::{
    ffi::CString,
    fs::File,
    io::Write,
    os::fd::{AsRawFd, FromRawFd},
};

#[cfg(unix)]
/// Replace a small state file without exposing an empty or partially
/// written file if the process is interrupted. Both names are resolved
/// against the same pinned parent directory, and the temporary file is
/// created exclusively without following a symlink.
pub(crate) fn confined_atomic_write(
    root: &Path,
    rel: &Path,
    bytes: &[u8],
) -> Result<(), StoreError> {
    let (dir, name) = open_parent(root, rel, true)?;
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: the parent fd, name, and stat buffer are valid. Never follow
    // the final component when checking whether it is a symlink.
    let status = unsafe {
        libc::fstatat(
            dir.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if status == 0 {
        // SAFETY: successful fstatat initialized the struct.
        let mode = unsafe { stat.assume_init() }.st_mode;
        if mode & libc::S_IFMT == libc::S_IFLNK {
            return Err(StoreError::InvalidPath(
                "target may not be a symlink".into(),
            ));
        }
    } else {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ENOENT) {
            return Err(StoreError::Io(error));
        }
    }
    let temp = CString::new(format!(".opensesame-state-{:032x}", rand::random::<u128>()))
        .map_err(|_| StoreError::InvalidPath("invalid temporary name".into()))?;
    let flags = libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    // SAFETY: the directory fd and NUL-terminated temporary name are valid.
    let fd = unsafe { libc::openat(dir.as_raw_fd(), temp.as_ptr(), flags, 0o600) };
    if fd < 0 {
        return Err(StoreError::Io(std::io::Error::last_os_error()));
    }
    // SAFETY: successful openat returned a new owned descriptor.
    let mut file = unsafe { File::from_raw_fd(fd) };
    let result = (|| -> Result<(), StoreError> {
        file.write_all(bytes)?;
        file.sync_all()?;
        // Replacing the final directory entry never follows a target
        // symlink, even if it changes concurrently.
        // SAFETY: both names and the pinned parent fd are valid.
        if unsafe {
            libc::renameat(
                dir.as_raw_fd(),
                temp.as_ptr(),
                dir.as_raw_fd(),
                name.as_ptr(),
            )
        } < 0
        {
            return Err(StoreError::Io(std::io::Error::last_os_error()));
        }
        if let Err(error) = dir.sync_all() {
            // Some filesystems do not support syncing a directory. The
            // rename is still atomic for a process interruption there,
            // though power-loss durability depends on the filesystem.
            if !matches!(
                error.raw_os_error(),
                Some(libc::EINVAL) | Some(libc::EOPNOTSUPP)
            ) {
                return Err(StoreError::Io(error));
            }
        }
        Ok(())
    })();
    if result.is_err() {
        // SAFETY: deleting the temporary directory entry never follows a symlink.
        let _ = unsafe { libc::unlinkat(dir.as_raw_fd(), temp.as_ptr(), 0) };
    }
    result
}

#[cfg(not(unix))]
pub(crate) fn confined_atomic_write(
    root: &Path,
    rel: &Path,
    bytes: &[u8],
) -> Result<(), StoreError> {
    // Windows delegates to the existing handle-confined private-file writer;
    // unsupported platforms inherit the existing fail-closed implementation.
    super::confined_replace(root, rel, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_replacement_rejects_parent_traversal() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("store");
        std::fs::create_dir(&root).unwrap();
        let outside = parent.path().join("outside");
        std::fs::write(&outside, b"keep").unwrap();
        assert!(confined_atomic_write(&root, Path::new("../outside"), b"new").is_err());
        assert_eq!(std::fs::read(outside).unwrap(), b"keep");
    }

    #[test]
    fn failed_atomic_replacement_keeps_previous_target_and_cleans_temporary_file() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("state")).unwrap();
        std::fs::write(root.path().join("state/keep"), b"keep").unwrap();
        assert!(confined_atomic_write(root.path(), Path::new("state"), b"new").is_err());
        assert_eq!(
            std::fs::read(root.path().join("state/keep")).unwrap(),
            b"keep"
        );
        let names = std::fs::read_dir(root.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        assert_eq!(names.len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_replacement_refuses_a_target_symlink() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("target");
        std::fs::write(&target, b"keep").unwrap();
        symlink(&target, root.path().join("state")).unwrap();
        assert!(confined_atomic_write(root.path(), Path::new("state"), b"new").is_err());
        assert_eq!(std::fs::read(target).unwrap(), b"keep");
    }
}
