//! Canonical identities for the local revision maps.

use std::collections::BTreeMap;

use crate::path::logical_to_relative;
use crate::{StoreError, StoreRoot};

/// Use the same logical path spelling as filesystem resolution. Older maps
/// may contain several raw spellings of one path; never choose a smaller one.
pub(crate) fn revision_identity(name: &str) -> Result<String, StoreError> {
    let relative = logical_to_relative(name)?;
    let mut parts = Vec::new();
    for component in relative.components() {
        let std::path::Component::Normal(part) = component else {
            return Err(StoreError::InvalidPath("invalid path component".into()));
        };
        parts.push(
            part.to_str()
                .ok_or_else(|| StoreError::InvalidPath("non-UTF-8 path".into()))?,
        );
    }
    Ok(parts.join("/"))
}

pub(crate) fn revision_for(
    revisions: &BTreeMap<String, u64>,
    name: &str,
) -> Result<Option<u64>, StoreError> {
    let identity = revision_identity(name)?;
    Ok(revisions.get(&identity).copied())
}

/// Fold old raw spellings once on load, retaining the greatest value. This
/// keeps a store-wide rotation from scanning the whole map for each entry.
pub(crate) fn normalize_revisions(raw: BTreeMap<String, u64>) -> BTreeMap<String, u64> {
    let mut normalized = BTreeMap::new();
    for (name, revision) in raw {
        // Preserve unrelated invalid legacy keys rather than discarding data;
        // no valid logical name can resolve to one of them.
        let identity = revision_identity(&name).unwrap_or(name);
        let current = normalized.entry(identity).or_insert(revision);
        *current = (*current).max(revision);
    }
    normalized
}

pub(crate) fn set_revision(
    revisions: &mut BTreeMap<String, u64>,
    name: &str,
    revision: u64,
) -> Result<(), StoreError> {
    let identity = revision_identity(name)?;
    revisions.insert(identity, revision);
    Ok(())
}

impl StoreRoot {
    pub(crate) fn revision(&self, name: &str) -> Result<Option<u64>, StoreError> {
        revision_for(&self.revisions()?, name)
    }
}
