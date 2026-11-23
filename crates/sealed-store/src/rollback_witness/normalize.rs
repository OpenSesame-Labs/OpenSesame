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
        match normalized.get_mut(&identity) {
            Some(current) => merge(current, candidate)?,
            None => {
                normalized.insert(identity, candidate);
            }
        }
    }
    Ok(normalized)
}

/// Fold one spelling into another: the higher revision wins, and at the same
/// revision the bindings must agree while a tombstone is never dropped.
fn merge(current: &mut EntryWitness, candidate: EntryWitness) -> Result<(), StoreError> {
    if candidate.revision > current.revision {
        *current = candidate;
        return Ok(());
    }
    if candidate.revision < current.revision {
        return Ok(());
    }
    if current.commitment != candidate.commitment
        && current.commitment != [0; 32]
        && candidate.commitment != [0; 32]
    {
        return Err(StoreError::Crypto(
            "rollback witness bindings disagree at the same revision".into(),
        ));
    }
    if current.commitment == [0; 32] {
        current.commitment = candidate.commitment;
    }
    current.deleted |= candidate.deleted;
    Ok(())
}
