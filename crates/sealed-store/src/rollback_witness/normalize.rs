//! Canonicalize witness identities without weakening an existing tombstone.
use std::collections::BTreeMap;

use super::EntryWitness;
use crate::StoreError;

pub(super) fn entries(
    original: BTreeMap<String, EntryWitness>,
) -> Result<BTreeMap<String, EntryWitness>, StoreError> {
    let mut normalized: BTreeMap<String, EntryWitness> = BTreeMap::new();
    for (name, candidate) in original {
        let identity = crate::store::revision_identity(&name)?;
        normalized
            .entry(identity)
            .and_modify(|current| {
                if candidate.revision > current.revision {
                    *current = candidate;
                } else if candidate.revision == current.revision {
                    current.deleted |= candidate.deleted;
                }
            })
            .or_insert(candidate);
    }
    Ok(normalized)
}
