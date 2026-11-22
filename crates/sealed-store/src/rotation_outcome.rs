use opensesame_human_vault::root_protection::ReissuedRecovery;

use crate::{RotationGitNotice, StoreError};

/// What a completed rotation did.
pub struct RotationOutcome {
    /// `.osseal` entries re-encrypted under the new root.
    pub entries: usize,
    /// Attachments (manifest and every chunk) re-encrypted under the new root.
    pub attachments: usize,
    /// `.gpg` / `.age` entries, which are not sealed under the root and were
    /// left exactly as they were.
    pub foreign_entries: usize,
    /// The manifest's root epoch after rotation.
    pub root_epoch: u64,
    /// Recovery keys minted in place of the old ones; show each once.
    pub reissued_recovery: Vec<ReissuedRecovery>,
    /// Git could not record the already committed rotation. The new root is
    /// live; repair Git and back up this state.
    pub git_error: Option<StoreError>,
    /// Automatic Git is deferred when one-time recovery keys must be delivered.
    pub git_deferred: bool,
    /// A non-fatal backup status from the automatic Git step, if one ran.
    pub git_notice: Option<RotationGitNotice>,
    /// The post-commit delivery callback failed; rotation remains committed.
    pub delivery_error: Option<std::io::Error>,
}
