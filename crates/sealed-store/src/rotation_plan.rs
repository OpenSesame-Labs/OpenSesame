use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::path::confined_write;
use crate::rollback_witness::WitnessRekey;
use crate::rotation_walk::inventory;
use crate::StoreError;

#[derive(Default)]
pub(super) struct Plan {
    pub(super) swaps: Vec<PathBuf>,
    pub(super) new_objects: Vec<PathBuf>,
    pub(super) kept_objects: BTreeSet<String>,
    pub(super) entries: usize,
    pub(super) attachments: usize,
    pub(super) foreign_entries: usize,
    pub(super) witness: Option<WitnessRekey>,
}

impl Plan {
    pub(super) fn stage(
        &mut self,
        staging: &Path,
        rel: PathBuf,
        bytes: &[u8],
    ) -> Result<(), StoreError> {
        let slot = Path::new("new").join(self.swaps.len().to_string());
        confined_write(staging, &slot, bytes)?;
        self.swaps.push(rel);
        Ok(())
    }
}

/// Fail closed if any root-sealed file in the tree was not re-encrypted: the
/// key swap would strand it under the old root.
pub(super) fn verify_nothing_left_behind(root: &Path, plan: &Plan) -> Result<(), StoreError> {
    let swapped: BTreeSet<&PathBuf> = plan.swaps.iter().collect();
    let missed = inventory(root)?
        .relative_paths()
        .into_iter()
        .filter(|rel| !swapped.contains(rel))
        .count();
    if missed > 0 {
        return Err(StoreError::Crypto(format!(
            "{missed} sealed file(s) appeared that were not re-encrypted; the rotation was \
             rolled back so none of them is left under the old root"
        )));
    }
    Ok(())
}
