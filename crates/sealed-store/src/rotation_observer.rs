use std::path::Path;

use opensesame_human_vault::root_protection::RotationEdit;

use super::{rotate_store_root_with_callbacks, RotationOutcome};
use crate::StoreError;

/// Rotate the root and deliver the committed outcome before cleanup or Git.
///
/// The callback runs while the exclusive store lock and rotation staging guard
/// are held. It must return promptly and must not call back into the store.
/// A callback error is recorded in `delivery_error`; the committed root is not
/// rolled back. A process crash before callback delivery can still lose keys.
///
/// # Errors
///
/// Returns pre-commit rotation errors; callback failures are in the outcome.
pub fn rotate_store_root_with_commit(
    root: &Path,
    password: &[u8],
    edit: RotationEdit<'_>,
    committed: &mut dyn FnMut(&RotationOutcome) -> std::io::Result<()>,
) -> Result<RotationOutcome, StoreError> {
    rotate_store_root_with_callbacks(root, password, edit, &mut |_| {}, committed)
}
