//! Entry removal, listing, search, and copy/move operations.

use super::{
    auto_commit, confined_remove, fs, ItemDataKey, Path, StoreError, StoreLock, StoreRoot,
    COMMIT_REMOVE,
};
use crate::path::relative_to_logical;

fn collect_entry_names(
    dir: &Path,
    root: &Path,
    prefix: &str,
    names: &mut Vec<String>,
) -> Result<(), StoreError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        if path.is_dir() {
            collect_entry_names(&path, root, prefix, names)?;
            continue;
        }
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let Some(extension) = relative.extension().and_then(|value| value.to_str()) else {
            continue;
        };
        if !matches!(extension, "osseal" | "gpg" | "age") {
            continue;
        }
        let Ok(logical) = relative_to_logical(relative) else {
            continue;
        };
        if prefix.is_empty() || logical == prefix || logical.starts_with(&format!("{prefix}/")) {
            names.push(logical);
        }
    }
    Ok(())
}

impl StoreRoot {
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn rm(&self, name: &str) -> Result<(), StoreError> {
        self.rm_with_optional_key(name, None)
    }

    /// Remove a native entry after durably writing its authenticated tombstone.
    ///
    /// # Errors
    ///
    /// Returns an error when the key is stale, the entry is absent, or the
    /// tombstone cannot be committed before unlinking the ciphertext.
    pub fn rm_with_key(&self, name: &str, key: &ItemDataKey) -> Result<(), StoreError> {
        self.rm_with_optional_key(name, Some(key))
    }

    fn rm_with_optional_key(
        &self,
        name: &str,
        key: Option<&ItemDataKey>,
    ) -> Result<(), StoreError> {
        let (path, hint) = self.find_existing(name)?;
        let rel = path
            .strip_prefix(&self.path)
            .map_err(|_| StoreError::InvalidPath("path escapes store root".into()))?;
        let _lock = StoreLock::for_writing(&self.path, name, key)?;
        if hint == super::FormatHint::Osseal {
            let key = key.ok_or_else(|| StoreError::NotInitialized(self.path.clone()))?;
            self.tombstone_entry(name, key)?;
        }
        confined_remove(&self.path, rel)?;
        auto_commit(&self.path, COMMIT_REMOVE)?;
        Ok(())
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn ls(&self, prefix: &str) -> Result<Vec<String>, StoreError> {
        let prefix = prefix.trim().trim_matches('/');
        let mut names = Vec::new();
        if !self.path.exists() {
            return Ok(names);
        }
        collect_entry_names(&self.path, &self.path, prefix, &mut names)?;
        names.sort();
        Ok(names)
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn find(&self, query: &str) -> Result<Vec<String>, StoreError> {
        let q = query.to_lowercase();
        Ok(self
            .ls("")?
            .into_iter()
            .filter(|n| n.to_lowercase().contains(&q))
            .collect())
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn cp(
        &self,
        from: &str,
        to: &str,
        key: &ItemDataKey,
        age_identity: Option<&str>,
    ) -> Result<(), StoreError> {
        let entry = self.show_with_age_identity(from, key, age_identity)?;
        self.insert(to, &entry, key)?;
        Ok(())
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn mv(
        &self,
        from: &str,
        to: &str,
        key: &ItemDataKey,
        age_identity: Option<&str>,
    ) -> Result<(), StoreError> {
        let entry = self.show_with_age_identity(from, key, age_identity)?;
        self.insert(to, &entry, key)?;
        self.rm_with_key(from, key)?;
        Ok(())
    }
}
