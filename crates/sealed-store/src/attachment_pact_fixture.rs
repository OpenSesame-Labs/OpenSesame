use super::*;
use crate::store::{init_store, init_store_key};
use tempfile::TempDir;

pub(super) fn store() -> (TempDir, StoreRoot, ItemDataKey) {
    let dir = TempDir::new().expect("tempdir");
    let root = init_store(dir.path(), &[]).expect("init");
    let key = init_store_key(dir.path(), b"correct horse").expect("key");
    (dir, root, key)
}

pub(super) fn add(
    root: &StoreRoot,
    key: &ItemDataKey,
    name: &str,
    bytes: &[u8],
) -> AttachmentSummary {
    let mut source = std::io::Cursor::new(bytes.to_vec());
    root.attach_add(
        name,
        &mut source,
        u64::try_from(bytes.len()).expect("fixture length fits u64"),
        AttachMeta {
            filename: "scan.pdf".into(),
            mime: None,
        },
        key,
        false,
    )
    .expect("attach_add")
}

pub(super) fn get(root: &StoreRoot, key: &ItemDataKey, name: &str) -> Result<Vec<u8>, StoreError> {
    let mut sink: Vec<u8> = Vec::new();
    root.attach_get(name, &mut sink, key)?;
    Ok(sink)
}
