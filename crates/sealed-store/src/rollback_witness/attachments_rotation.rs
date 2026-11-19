//! Rotation-time witness checks for resealed attachment manifests.

use super::{EntryWitness, Witness};

const ATTACHMENT_MARKER: &str = ".attachments/.rollback-anchor-v1";
const ATTACHMENT_PREFIX: &str = ".attachments/.rollback-witness/";

pub(super) fn rotation_prepared_witness_allows_pending(
    current: &Witness,
    expected: &Witness,
) -> bool {
    if current.version != expected.version || current.epoch != expected.epoch {
        return false;
    }
    if current.entries.len() != expected.entries.len() {
        return false;
    }
    let mut attachment_commitment_delta = false;
    for (name, entry) in &current.entries {
        let Some(expected_entry) = expected.entries.get(name) else {
            return false;
        };
        if name == ATTACHMENT_MARKER || name.starts_with(ATTACHMENT_PREFIX) {
            if entry.revision != expected_entry.revision || entry.deleted != expected_entry.deleted {
                return false;
            }
            if entry.commitment != expected_entry.commitment {
                attachment_commitment_delta = true;
            }
            continue;
        }
        if entry != expected_entry {
            return false;
        }
    }
    attachment_commitment_delta
}