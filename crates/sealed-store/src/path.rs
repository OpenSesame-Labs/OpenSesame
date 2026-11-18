use std::path::{Component, Path, PathBuf};

use crate::StoreError;

#[cfg(unix)]
mod confined {
    use std::ffi::CString;
    use std::fs::File;
    use std::io::{Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::OpenOptionsExt;
    use std::path::{Component, Path};

    use crate::StoreError;

    fn open_directory_component(
        parent: &File,
        name: &CString,
        create: bool,
    ) -> Result<File, StoreError> {
        let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        // SAFETY: the directory fd and NUL-terminated component remain valid for the call.
        let mut fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 && create && std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT)
        {
            // SAFETY: same valid fd/component pair; mode creates a private directory.
            let made = unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) };
            if made < 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST) {
                return Err(StoreError::Io(std::io::Error::last_os_error()));
            }
            // SAFETY: reopen refuses a symlink even if another process won the create race.
            fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
        }
        if fd < 0 {
            return Err(StoreError::Io(std::io::Error::last_os_error()));
        }
        // SAFETY: successful openat returns a new owned descriptor.
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    fn open_parent(root: &Path, rel: &Path, create: bool) -> Result<(File, CString), StoreError> {
        let mut dir = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(root)?;
        let file_name = rel
            .file_name()
            .ok_or_else(|| StoreError::InvalidPath("missing file name".into()))?;
        for component in rel.parent().into_iter().flat_map(Path::components) {
            let Component::Normal(name) = component else {
                return Err(StoreError::InvalidPath("invalid path component".into()));
            };
            let name = CString::new(name.as_bytes())
                .map_err(|_| StoreError::InvalidPath("NUL in path".into()))?;
            dir = open_directory_component(&dir, &name, create)?;
        }
        let file_name = CString::new(file_name.as_bytes())
            .map_err(|_| StoreError::InvalidPath("NUL in path".into()))?;
        Ok((dir, file_name))
    }

    pub fn write(root: &Path, rel: &Path, bytes: &[u8]) -> Result<(), StoreError> {
        let (dir, name) = open_parent(root, rel, true)?;
        let flags =
            libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        // SAFETY: valid directory fd/component; O_NOFOLLOW blocks a final symlink.
        let fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags, 0o600) };
        if fd < 0 {
            return Err(StoreError::Io(std::io::Error::last_os_error()));
        }
        // SAFETY: successful openat returns a new owned descriptor.
        let mut file = unsafe { File::from_raw_fd(fd) };
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok(())
    }

    pub fn replace(root: &Path, rel: &Path, bytes: &[u8]) -> Result<(), StoreError> {
        let (dir, name) = open_parent(root, rel, true)?;
        let mut temporary = b".".to_vec();
        temporary.extend_from_slice(name.as_bytes());
        temporary.extend_from_slice(b".new");
        let temporary = CString::new(temporary)
            .map_err(|_| StoreError::InvalidPath("NUL in temporary file name".into()))?;
        // A crash before rename may leave only this unpublished temporary.
        unsafe { libc::unlinkat(dir.as_raw_fd(), temporary.as_ptr(), 0) };
        let flags =
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        // SAFETY: valid directory fd/component; O_EXCL and O_NOFOLLOW prevent replacement races.
        let fd = unsafe { libc::openat(dir.as_raw_fd(), temporary.as_ptr(), flags, 0o600) };
        if fd < 0 {
            return Err(StoreError::Io(std::io::Error::last_os_error()));
        }
        // SAFETY: successful openat returns a new owned descriptor.
        let mut file = unsafe { File::from_raw_fd(fd) };
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        // SAFETY: both names are confined to the same opened directory; rename is atomic.
        if unsafe {
            libc::renameat(
                dir.as_raw_fd(),
                temporary.as_ptr(),
                dir.as_raw_fd(),
                name.as_ptr(),
            )
        } < 0
        {
            return Err(StoreError::Io(std::io::Error::last_os_error()));
        }
        dir.sync_all()?;
        Ok(())
    }

    pub fn read(root: &Path, rel: &Path) -> Result<Vec<u8>, StoreError> {
        let (dir, name) = open_parent(root, rel, false)?;
        // SAFETY: valid directory fd/component; O_NOFOLLOW blocks a final symlink.
        let fd = unsafe {
            libc::openat(
                dir.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(StoreError::Io(std::io::Error::last_os_error()));
        }
        // SAFETY: successful openat returns a new owned descriptor.
        let mut file = unsafe { File::from_raw_fd(fd) };
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        Ok(bytes)
    }

    pub fn remove(root: &Path, rel: &Path) -> Result<(), StoreError> {
        let (dir, name) = open_parent(root, rel, false)?;
        // SAFETY: valid directory fd/component; unlinkat removes the directory entry itself.
        if unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), 0) } < 0 {
            return Err(StoreError::Io(std::io::Error::last_os_error()));
        }
        Ok(())
    }
}

#[cfg(unix)]
pub(crate) use confined::{
    read as confined_read, remove as confined_remove, replace as confined_replace,
    write as confined_write,
};

#[cfg(windows)]
mod confined_windows {
    use std::path::{Component, Path, PathBuf};
    use std::sync::Arc;

    use opensesame_human_vault::root_protection::windows_private_files::{
        atomic_write, remove_confined_file, HeldPrivateRead, PrivateDirectory,
    };

    use crate::StoreError;

    const MAX_CONFINED_FILE_BYTES: usize = 16 * 1024 * 1024;

    fn ordinary_absolute(root: &Path) -> Result<PathBuf, StoreError> {
        let supplied = if root.is_absolute() {
            root.to_path_buf()
        } else {
            std::env::current_dir()?.join(root)
        };
        let mut absolute = PathBuf::new();
        for component in supplied.components() {
            match component {
                Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                    absolute.push(component.as_os_str());
                }
                Component::CurDir | Component::ParentDir => {
                    return Err(StoreError::InvalidPath(
                        "store root contains a dot component".into(),
                    ));
                }
            }
        }
        Ok(absolute)
    }

    fn parent_and_name<'a>(
        root: &Path,
        rel: &'a Path,
        create: bool,
    ) -> Result<(PrivateDirectory, &'a Path), StoreError> {
        if rel.is_absolute()
            || rel
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(StoreError::InvalidPath("invalid relative path".into()));
        }
        let name = rel
            .file_name()
            .map(Path::new)
            .ok_or_else(|| StoreError::InvalidPath("missing file name".into()))?;
        let absolute_root = ordinary_absolute(root)?;
        let parent = absolute_root.join(rel.parent().unwrap_or_else(|| Path::new("")));
        let directory = if create {
            PrivateDirectory::create_confined_directories(&parent)
        } else {
            PrivateDirectory::open_confined(&parent)
        }
        .map_err(StoreError::Io)?;
        Ok((directory, name))
    }

    pub fn write(root: &Path, rel: &Path, bytes: &[u8]) -> Result<(), StoreError> {
        let (directory, name) = parent_and_name(root, rel, true)?;
        atomic_write(&directory, name, bytes).map_err(StoreError::Io)
    }

    pub fn replace(root: &Path, rel: &Path, bytes: &[u8]) -> Result<(), StoreError> {
        write(root, rel, bytes)
    }

    pub fn read(root: &Path, rel: &Path) -> Result<Vec<u8>, StoreError> {
        let (directory, name) = parent_and_name(root, rel, false)?;
        let held =
            HeldPrivateRead::open_confined(Arc::new(directory), name, MAX_CONFINED_FILE_BYTES)
                .map_err(StoreError::Io)?;
        Ok(held.bytes().to_vec())
    }

    pub fn remove(root: &Path, rel: &Path) -> Result<(), StoreError> {
        let (directory, name) = parent_and_name(root, rel, false)?;
        remove_confined_file(&directory, name).map_err(StoreError::Io)
    }
}

#[cfg(windows)]
pub(crate) use confined_windows::{
    read as confined_read, remove as confined_remove, replace as confined_replace,
    write as confined_write,
};

#[cfg(not(any(unix, windows)))]
fn unsupported_confined<T>() -> Result<T, StoreError> {
    Err(StoreError::InvalidPath(
        "secure confined filesystem operations are unsupported on this platform".into(),
    ))
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn confined_write(_: &Path, _: &Path, _: &[u8]) -> Result<(), StoreError> {
    unsupported_confined()
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn confined_replace(_: &Path, _: &Path, _: &[u8]) -> Result<(), StoreError> {
    unsupported_confined()
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn confined_read(_: &Path, _: &Path) -> Result<Vec<u8>, StoreError> {
    unsupported_confined()
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn confined_remove(_: &Path, _: &Path) -> Result<(), StoreError> {
    unsupported_confined()
}

/// Map a logical `pass`-style name to a relative path (no extension).
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn logical_to_relative(name: &str) -> Result<PathBuf, StoreError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(StoreError::InvalidPath("empty name".into()));
    }
    if name.contains('\0') {
        return Err(StoreError::InvalidPath("NUL in name".into()));
    }
    let path = PathBuf::from(name);
    if path.is_absolute() {
        return Err(StoreError::InvalidPath("absolute path".into()));
    }
    // `components()` normalizes away a trailing `/`, a doubled `//` and an
    // interior `.`, so check the raw segments too: `Dev/` would otherwise be
    // written as `Dev/.osseal`, a file with no stem that nothing can list,
    // rotate or reach by its name again.
    if name
        .split('/')
        .any(|seg| seg.is_empty() || seg == "." || seg == "..")
    {
        return Err(StoreError::InvalidPath(
            "empty, `.` or `..` segment (trailing or doubled `/`)".into(),
        ));
    }
    for component in path.components() {
        match component {
            Component::Normal(seg) => {
                let s = seg.to_string_lossy();
                if s.is_empty() || s == "." || s == ".." {
                    return Err(StoreError::InvalidPath(format!("bad segment: {s}")));
                }
            }
            Component::CurDir | Component::ParentDir => {
                return Err(StoreError::InvalidPath("`.` or `..` not allowed".into()));
            }
            _ => return Err(StoreError::InvalidPath("invalid path component".into())),
        }
    }
    Ok(path)
}

/// Strip a known ciphertext extension and return the logical name.
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn relative_to_logical(rel: &Path) -> Result<String, StoreError> {
    if rel.is_absolute() {
        return Err(StoreError::InvalidPath("absolute relative path".into()));
    }
    let mut path = rel.to_path_buf();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        if matches!(ext, "osseal" | "gpg" | "age") {
            path.set_extension("");
        }
    }
    let logical = path
        .to_str()
        .ok_or_else(|| StoreError::InvalidPath("non-utf8 path".into()))?
        .replace('\\', "/");
    if logical.is_empty() {
        return Err(StoreError::InvalidPath("empty logical name".into()));
    }
    Ok(logical)
}

#[cfg(test)]
mod pact {
    use super::*;
    use std::path::Path;

    #[test]
    fn property_nested_logical_names_round_trip() {
        for name in ["Email/github.com", "Dev/api-token", "a/b/c"] {
            let rel = logical_to_relative(name).unwrap();
            assert_eq!(relative_to_logical(&rel).unwrap(), name);
        }
    }

    #[test]
    fn adversarial_traversal_and_nul_are_refused() {
        for name in [
            "../etc/passwd",
            "foo/../bar",
            "/etc/passwd",
            "a\0b",
            "",
            "..",
            "Dev/",
            "Dev//token",
            "Dev/./token",
            "Scans/",
        ] {
            assert!(logical_to_relative(name).is_err(), "{name:?}");
        }
    }

    #[test]
    fn chaos_interleaved_rejects_stay_closed() {
        let mixed = ["ok/name", "../x", "also/ok", "foo/../bar"];
        let accepted: Vec<_> = mixed
            .iter()
            .copied()
            .filter(|n| logical_to_relative(n).is_ok())
            .collect();
        assert_eq!(accepted, ["ok/name", "also/ok"]);
    }

    #[test]
    fn contract_ciphertext_extensions_strip_to_logical_names() {
        assert_eq!(
            relative_to_logical(Path::new("Email/github.com.osseal")).unwrap(),
            "Email/github.com"
        );
        assert_eq!(relative_to_logical(Path::new("a/b.age")).unwrap(), "a/b");
        assert_eq!(relative_to_logical(Path::new("a/b.gpg")).unwrap(), "a/b");
    }
}
