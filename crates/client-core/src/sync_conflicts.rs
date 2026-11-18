//! Refuse different authenticated ciphertext at the same item and epoch.

use std::collections::BTreeMap;

use crate::{ClientCoreError, SyncBlob};

pub(crate) fn validate(
    entries: &BTreeMap<String, (u64, Vec<u8>)>,
    incoming: &[SyncBlob],
) -> Result<(), ClientCoreError> {
    let mut seen: BTreeMap<(&str, u64), &[u8]> = BTreeMap::new();
    for blob in incoming {
        if entries.get(&blob.id).is_some_and(|(epoch, ciphertext)| {
            *epoch == blob.epoch && *ciphertext != blob.ciphertext
        }) || seen
            .insert((blob.id.as_str(), blob.epoch), blob.ciphertext.as_slice())
            .is_some_and(|previous| previous != blob.ciphertext.as_slice())
        {
            return Err(ClientCoreError::InvalidBlob(
                "conflicting ciphertext at the same sync epoch",
            ));
        }
    }
    Ok(())
}
