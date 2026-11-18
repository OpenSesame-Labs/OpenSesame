//! Owner-private physical directory pins, not password or vault-root authority.
//! Existing roots are checked, never chmodded, repaired or silently provisioned.

#[path = "windows_private_files/child.rs"]
mod child;
#[path = "windows_private_files/handles.rs"]
mod handles;
#[path = "windows_private_files/security.rs"]
mod security;

#[path = "windows_private_files/publish.rs"]
mod publish;
pub use publish::{
    atomic_create_with, atomic_write, atomic_write_with, remove_confined_file, remove_file,
    write_new,
};
#[path = "windows_private_files/read.rs"]
mod read;
pub use read::HeldPrivateRead;
#[path = "windows_private_files/store_lock.rs"]
mod store_lock;
pub use store_lock::HeldPrivateStoreLock;

use std::{
    fs::File,
    io,
    path::{Path, PathBuf},
};

/// A local NTFS root and every ancestor retained without delete sharing.
/// This object proves a bounded filesystem profile, never authentication.
pub struct PrivateDirectory {
    parents: Vec<File>,
    paths: Vec<PathBuf>,
    identities: Vec<handles::Identity>,
    owner: String,
    private_start: usize,
    require_private: bool,
}

impl PrivateDirectory {
    /// Open an existing absolute, non-aliased root with the strict private profile.
    ///
    /// # Errors
    /// Refuses reparse paths, unsupported volumes, broad/foreign ACLs and IO errors.
    pub fn open(root: &Path) -> io::Result<Self> {
        Self::pin(root, false, false, true)
    }

    /// Pin an existing local NTFS directory chain without requiring a legacy
    /// store root to already have OpenSesame's exact private ACL. Reparse
    /// points, aliases and profile changes are still refused, and files made
    /// beneath the retained handle receive private ACLs.
    ///
    /// # Errors
    /// Refuses non-local filesystems, reparse/alias paths, unsafe components,
    /// identity/profile changes and IO failures.
    pub fn open_confined(root: &Path) -> io::Result<Self> {
        Self::pin(root, false, false, false)
    }

    /// Create only missing directories with private ACLs, pinning every parent.
    /// Existing directories and ACLs are never repaired or permission-modified.
    ///
    /// # Errors
    /// Refuses an existing final root without the strict private profile, unsafe
    /// path/volume/profile changes and creation/IO errors. Created private empty
    /// directories can remain if a later step fails; this is not a transaction.
    pub fn create_directories(root: &Path) -> io::Result<Self> {
        Self::pin(root, true, false, true)
    }

    /// Pin an existing local NTFS chain and create only missing descendants
    /// with private ACLs. Existing ancestors may retain their reviewed legacy
    /// ACLs; exact handles and no-delete sharing provide confinement.
    ///
    /// # Errors
    /// Refuses unsafe existing paths, raced or non-private new descendants,
    /// unsupported filesystems, identity/profile changes and IO failures.
    pub fn create_confined_directories(root: &Path) -> io::Result<Self> {
        Self::pin(root, true, false, false)
    }

    /// Create a new private final directory under existing pinned ancestors.
    /// Existing final paths are refused, even when already owner-private.
    /// This physical operation does not grant vault-owner authority.
    ///
    /// # Errors
    /// Refuses existing destinations, missing ancestors, unsafe paths and IO failures.
    /// A newly created empty directory can remain after a later verification failure.
    pub fn create_new(root: &Path) -> io::Result<Self> {
        Self::pin(root, false, true, true)
    }

    fn pin(
        root: &Path,
        create_missing: bool,
        new_leaf: bool,
        require_private: bool,
    ) -> io::Result<Self> {
        let owner = security::owner_sid()?;
        let paths = handles::prefixes(root)?;
        let mut parents = Vec::new();
        let mut identities = Vec::new();
        let mut first_created = None;
        for (index, path) in paths.iter().enumerate() {
            if new_leaf && index + 1 == paths.len() {
                validate_creation_parent(&paths[..index], &parents, &identities, &owner)?;
                create_private_directory_new(path, &owner)?;
                if first_created.is_none() {
                    first_created = Some(index);
                }
            }
            let file = match handles::directory(path) {
                Ok(file) => file,
                Err(error) if create_missing && error.kind() == io::ErrorKind::NotFound => {
                    validate_creation_parent(&paths[..index], &parents, &identities, &owner)?;
                    create_private_directory(path, &owner)?;
                    if first_created.is_none() {
                        first_created = Some(index);
                    }
                    let file = handles::directory(path)?;
                    security::verify(&file, &owner, true)?;
                    file
                }
                Err(error) => return Err(error),
            };
            identities.push(handles::identity(&file, true)?);
            if let Some(parent) = parents.last() {
                let name = path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .ok_or_else(security::refused)?;
                handles::child_relation(parent, &file, name)?;
            }
            parents.push(file);
        }
        let private_start = if require_private {
            parents.len().checked_sub(1).ok_or_else(security::refused)?
        } else {
            first_created.unwrap_or(parents.len())
        };
        let opened = Self {
            parents,
            paths,
            identities,
            owner,
            private_start,
            require_private,
        };
        opened.validate()?;
        Ok(opened)
    }

    pub(crate) fn validate(&self) -> io::Result<()> {
        if security::owner_sid()? != self.owner {
            return Err(security::refused());
        }
        validate_ancestor_chain(&self.paths, &self.parents, &self.identities)?;
        let root = self.parents.last().ok_or_else(security::refused)?;
        handles::local_ntfs(root, &self.paths[0])?;
        let private = self
            .parents
            .get(self.private_start..)
            .ok_or_else(security::refused)?;
        if self.require_private && private.is_empty() {
            return Err(security::refused());
        }
        for directory in private {
            security::verify(directory, &self.owner, true)?;
        }
        Ok(())
    }

    pub(crate) fn path_for(&self, name: &Path) -> io::Result<PathBuf> {
        let text = name.to_str().ok_or_else(security::refused)?;
        handles::component_policy(text)?;
        let root = self.paths.last().ok_or_else(security::refused)?;
        let path = root.join(name);
        if path
            .to_str()
            .ok_or_else(security::refused)?
            .encode_utf16()
            .count()
            > 32760
        {
            return Err(security::refused());
        }
        Ok(path)
    }

    pub(crate) fn root_handle(&self) -> io::Result<&File> {
        self.parents.last().ok_or_else(security::refused)
    }
}

fn validate_ancestor_chain(
    paths: &[PathBuf],
    parents: &[File],
    identities: &[handles::Identity],
) -> io::Result<()> {
    if paths.is_empty() || paths.len() != parents.len() || paths.len() != identities.len() {
        return Err(security::refused());
    }
    for (index, parent) in parents.iter().enumerate() {
        if handles::identity(parent, true)? != identities[index] {
            return Err(security::refused());
        }
        if index > 0 {
            let name = paths[index]
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(security::refused)?;
            handles::child_relation(&parents[index - 1], parent, name)?;
        }
    }
    handles::drive_relation(&parents[0], &paths[0])
}

fn validate_creation_parent(
    paths: &[PathBuf],
    parents: &[File],
    identities: &[handles::Identity],
    owner: &str,
) -> io::Result<()> {
    validate_ancestor_chain(paths, parents, identities)?;
    if security::owner_sid()? != owner {
        return Err(security::refused());
    }
    let parent = parents.last().ok_or_else(security::refused)?;
    handles::local_ntfs(parent, paths.first().ok_or_else(security::refused)?)
}

fn create_private_directory(path: &Path, owner: &str) -> io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::CreateDirectoryW;
    let descriptor = security::Descriptor::private(owner, true)?;
    let attributes = descriptor.attributes()?;
    let path = handles::wide(path)?;
    // SAFETY: bounded terminated path and private descriptor stay owned throughout creation.
    if unsafe { CreateDirectoryW(path.as_ptr(), &raw const attributes) } == 0 {
        let error = io::Error::last_os_error();
        // A raced existing object still undergoes real handle/owner/private-ACL verification.
        if error.kind() != io::ErrorKind::AlreadyExists {
            return Err(error);
        }
    }
    Ok(())
}

fn create_private_directory_new(path: &Path, owner: &str) -> io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::CreateDirectoryW;
    let descriptor = security::Descriptor::private(owner, true)?;
    let attributes = descriptor.attributes()?;
    let path = handles::wide(path)?;
    // SAFETY: the terminated path and ACL descriptor remain owned during the call.
    if unsafe { CreateDirectoryW(path.as_ptr(), &raw const attributes) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[path = "windows_private_files/resource_identity.rs"]
mod resource_identity;

#[path = "windows_private_files/directory_inventory.rs"]
mod directory_inventory;

#[cfg(test)]
#[path = "windows_private_files/provision_tests.rs"]
mod provision_tests;

#[cfg(test)]
#[path = "windows_private_files/path_compatibility_tests.rs"]
mod path_compatibility_tests;

#[cfg(test)]
#[path = "windows_private_files/create_new_tests.rs"]
mod create_new_tests;

#[path = "windows_private_files/writer_lease.rs"]
mod writer_lease;
pub use writer_lease::HeldPrivateWriterLease;

#[path = "windows_private_files/compare_publish.rs"]
mod compare_publish;
pub(crate) use compare_publish::compare_publish;
