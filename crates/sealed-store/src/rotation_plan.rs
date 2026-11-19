use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::path::confined_write;
use crate::rollback_witness::WitnessRekey;
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
