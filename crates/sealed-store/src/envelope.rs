use opensesame_human_vault::{
    decrypt_item_with_ad, encrypt_item, AssociatedData, EncryptedEnvelope, ItemDataKey,
    ENVELOPE_VERSION,
};
use serde::{Deserialize, Serialize};

use crate::StoreError;

pub const OSSEAL_MAGIC: &[u8] = b"OSSEAL1\n";

#[derive(Serialize, Deserialize)]
struct OssealBody {
    envelope: EncryptedEnvelope,
}

/// Collection id bound into entry ciphertext.
pub(crate) const COLLECTION_ENTRIES: &str = "entries";
const LEGACY_ITEM_ID: &str = "sealed-store-entry";
// The old format used this item id for every entry. A real entry with the
// same name needs a different id and domain, so old clients cannot mistake
// it for the unbound format and silently rewrite it.
const COLLECTION_RESERVED_ENTRY: &str = "entries-reserved-name-v2";
const RESERVED_ENTRY_ID: &str = "sealed-store-entry@v2";

/// Collection id bound into attachment-manifest ciphertext. Binding a distinct
/// collection is what stops a manifest blob from being replayed as an entry, or
/// an entry as a manifest, even at the same logical path and revision.
pub(crate) const COLLECTION_ATTACHMENTS: &str = "attachments";

pub(crate) fn store_ad_in(collection_id: &str, name: &str, revision: u64) -> AssociatedData {
    AssociatedData {
        envelope_version: ENVELOPE_VERSION,
        item_id: name.into(),
        organization_id: "local".into(),
        project_id: "store".into(),
        collection_id: collection_id.into(),
        key_id: "idk".into(),
        revision,
    }
}

fn store_ad(name: &str, revision: u64) -> AssociatedData {
    if name == LEGACY_ITEM_ID {
        store_ad_in(COLLECTION_RESERVED_ENTRY, RESERVED_ENTRY_ID, revision)
    } else {
        store_ad_in(COLLECTION_ENTRIES, name, revision)
    }
}

/// Revision recorded in a sealed blob's associated data.
///
/// The AD travels in cleartext beside the ciphertext, so this needs no key. It
/// is only ever used to pick up counting on a machine that has no local
/// revision record yet — it is not evidence the blob is authentic.
pub fn envelope_revision(blob: &[u8]) -> Result<u64, StoreError> {
    if !blob.starts_with(OSSEAL_MAGIC) {
        return Err(StoreError::Crypto("missing OSSEAL1 magic".into()));
    }
    let body: OssealBody = serde_json::from_slice(&blob[OSSEAL_MAGIC.len()..])
        .map_err(|e| StoreError::Crypto(e.to_string()))?;
    Ok(body.envelope.ad.revision)
}

pub struct OpenedOsseal {
    pub plaintext: Vec<u8>,
    pub revision: u64,
    pub legacy: bool,
}

fn reject_unbound(body: &OssealBody) -> Result<(), StoreError> {
    if body.envelope.ad.item_id == LEGACY_ITEM_ID
        && body.envelope.ad.collection_id == COLLECTION_ENTRIES
    {
        return Err(StoreError::Crypto(
            "legacy entry has no authenticated name; verify its source and use \
             `opensesame vault pass protect migrate-legacy NAME --trust-source`"
                .into(),
        ));
    }
    Ok(())
}

/// Seal plaintext into an `.osseal`-framed blob bound to `collection_id`.
pub fn seal_osseal_in(
    collection_id: &str,
    plaintext: &[u8],
    content_key: &ItemDataKey,
    name: &str,
    revision: u64,
) -> Result<Vec<u8>, StoreError> {
    if revision == 0 {
        return Err(StoreError::Crypto("entry revision must be positive".into()));
    }
    if collection_id == COLLECTION_ENTRIES && name == LEGACY_ITEM_ID {
        return Err(StoreError::Crypto(
            "legacy entry context is reserved".into(),
        ));
    }
    let envelope = encrypt_item(
        content_key,
        plaintext,
        store_ad_in(collection_id, name, revision),
    )
    .map_err(|e| StoreError::Crypto(e.to_string()))?;
    let body = OssealBody { envelope };
    let json = serde_json::to_vec(&body).map_err(|e| StoreError::Crypto(e.to_string()))?;
    let mut out = Vec::with_capacity(OSSEAL_MAGIC.len() + json.len());
    out.extend_from_slice(OSSEAL_MAGIC);
    out.extend_from_slice(&json);
    Ok(out)
}

/// Seal plaintext into an `.osseal` blob (magic + JSON envelope).
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn seal_osseal(
    plaintext: &[u8],
    content_key: &ItemDataKey,
    name: &str,
    revision: u64,
) -> Result<Vec<u8>, StoreError> {
    if revision == 0 {
        return Err(StoreError::Crypto("entry revision must be positive".into()));
    }
    let envelope = encrypt_item(content_key, plaintext, store_ad(name, revision))
        .map_err(|e| StoreError::Crypto(e.to_string()))?;
    let body = OssealBody { envelope };
    let json = serde_json::to_vec(&body).map_err(|e| StoreError::Crypto(e.to_string()))?;
    let mut out = Vec::with_capacity(OSSEAL_MAGIC.len() + json.len());
    out.extend_from_slice(OSSEAL_MAGIC);
    out.extend_from_slice(&json);
    Ok(out)
}

/// Open an `.osseal`-framed blob bound to `collection_id`.
///
/// Legacy unbound entries are never accepted by this reader.
pub fn open_osseal_in(
    collection_id: &str,
    blob: &[u8],
    content_key: &ItemDataKey,
    name: &str,
    expected_revision: Option<u64>,
) -> Result<OpenedOsseal, StoreError> {
    if !blob.starts_with(OSSEAL_MAGIC) {
        return Err(StoreError::Crypto("missing OSSEAL1 magic".into()));
    }
    let json = &blob[OSSEAL_MAGIC.len()..];
    let body: OssealBody =
        serde_json::from_slice(json).map_err(|e| StoreError::Crypto(e.to_string()))?;
    reject_unbound(&body)?;
    let revision = expected_revision.unwrap_or(body.envelope.ad.revision);
    if revision == 0 {
        return Err(StoreError::Crypto("entry revision must be positive".into()));
    }
    let plaintext = decrypt_item_with_ad(
        content_key,
        &body.envelope,
        &store_ad_in(collection_id, name, revision),
    )
    .map_err(|e| StoreError::Crypto(e.to_string()))?;
    Ok(OpenedOsseal {
        plaintext,
        revision,
        legacy: false,
    })
}

/// Authenticate a collection envelope using its stored spelling only when it
/// resolves to the same logical path as the caller's name.
pub(crate) fn open_osseal_in_for_path(
    collection: &str,
    blob: &[u8],
    key: &ItemDataKey,
    name: &str,
    expected_revision: Option<u64>,
) -> Result<(OpenedOsseal, String), StoreError> {
    if !blob.starts_with(OSSEAL_MAGIC) {
        return Err(StoreError::Crypto("missing OSSEAL1 magic".into()));
    }
    let body: OssealBody = serde_json::from_slice(&blob[OSSEAL_MAGIC.len()..])
        .map_err(|error| StoreError::Crypto(error.to_string()))?;
    let bound_name = body.envelope.ad.item_id;
    if crate::store::revision_identity(&bound_name)? != crate::store::revision_identity(name)? {
        return Err(StoreError::Crypto(
            "attachment name does not match its path".into(),
        ));
    }
    let opened = open_osseal_in(collection, blob, key, &bound_name, expected_revision)?;
    Ok((opened, bound_name))
}

/// Open an `.osseal` blob.
///
/// # Errors
///
/// Returns an error when validation or the underlying operation fails.
pub fn open_osseal(
    blob: &[u8],
    content_key: &ItemDataKey,
    name: &str,
    expected_revision: Option<u64>,
) -> Result<OpenedOsseal, StoreError> {
    if !blob.starts_with(OSSEAL_MAGIC) {
        return Err(StoreError::Crypto("missing OSSEAL1 magic".into()));
    }
    let json = &blob[OSSEAL_MAGIC.len()..];
    let body: OssealBody =
        serde_json::from_slice(json).map_err(|e| StoreError::Crypto(e.to_string()))?;
    reject_unbound(&body)?;
    let revision = expected_revision.unwrap_or(body.envelope.ad.revision);
    if revision == 0 {
        return Err(StoreError::Crypto("entry revision must be positive".into()));
    }
    let plaintext = decrypt_item_with_ad(content_key, &body.envelope, &store_ad(name, revision))
        .map_err(|e| StoreError::Crypto(e.to_string()))?;
    Ok(OpenedOsseal {
        plaintext,
        revision,
        legacy: false,
    })
}

/// Authenticate the name carried by an existing envelope after confirming it
/// resolves to the same logical path. Used by anchor migration and rotation,
/// whose filesystem inventory cannot preserve older whitespace aliases.
pub(crate) fn open_osseal_for_path(
    blob: &[u8],
    key: &ItemDataKey,
    name: &str,
    expected_revision: Option<u64>,
) -> Result<OpenedOsseal, StoreError> {
    if !blob.starts_with(OSSEAL_MAGIC) {
        return Err(StoreError::Crypto("missing OSSEAL1 magic".into()));
    }
    let body: OssealBody = serde_json::from_slice(&blob[OSSEAL_MAGIC.len()..])
        .map_err(|error| StoreError::Crypto(error.to_string()))?;
    let bound_name = if body.envelope.ad.collection_id == COLLECTION_RESERVED_ENTRY
        && body.envelope.ad.item_id == RESERVED_ENTRY_ID
    {
        LEGACY_ITEM_ID
    } else {
        body.envelope.ad.item_id.as_str()
    };
    if crate::store::revision_identity(bound_name)? != crate::store::revision_identity(name)? {
        return Err(StoreError::Crypto(
            "entry name does not match its path".into(),
        ));
    }
    open_osseal(blob, key, bound_name, expected_revision)
}

/// Open only the old unbound format for an explicit, trusted-source migration.
/// Authenticity of the bytes does not establish their logical name or age.
///
/// Legacy envelopes predate positive revision accounting — the old reader
/// reported revision 0 for every one of them — so the revision carried here
/// may be zero. It only feeds the associated-data digest check; the rebound
/// blob always receives a fresh, positive revision from the witness state,
/// and the ordinary readers still reject revision 0.
pub(crate) fn open_legacy_for_trusted_migration(
    blob: &[u8],
    content_key: &ItemDataKey,
) -> Result<Vec<u8>, StoreError> {
    if !blob.starts_with(OSSEAL_MAGIC) {
        return Err(StoreError::Crypto("missing OSSEAL1 magic".into()));
    }
    let body: OssealBody = serde_json::from_slice(&blob[OSSEAL_MAGIC.len()..])
        .map_err(|e| StoreError::Crypto(e.to_string()))?;
    decrypt_item_with_ad(
        content_key,
        &body.envelope,
        &store_ad_in(
            COLLECTION_ENTRIES,
            LEGACY_ITEM_ID,
            body.envelope.ad.revision,
        ),
    )
    .map_err(|e| StoreError::Crypto(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn osseal_round_trip() {
        let key = ItemDataKey::generate();
        let pt = b"hello\nmeta: 1\n";
        let ct = seal_osseal(pt, &key, "Dev/token", 1).unwrap();
        assert!(ct.starts_with(OSSEAL_MAGIC));
        assert_eq!(
            open_osseal(&ct, &key, "Dev/token", Some(1))
                .unwrap()
                .plaintext,
            pt
        );
    }

    #[test]
    fn wrong_key_fails_closed() {
        let key = ItemDataKey::generate();
        let other = ItemDataKey::generate();
        assert_ne!(key.0, other.0);
        let ct = seal_osseal(b"secret", &key, "Dev/token", 1).unwrap();
        assert!(open_osseal(&ct, &other, "Dev/token", Some(1)).is_err());
    }

    #[test]
    fn path_and_revision_are_mandatory_context() {
        let key = ItemDataKey::generate();
        let ct = seal_osseal(b"secret", &key, "Dev/a", 2).unwrap();
        assert!(open_osseal(&ct, &key, "Dev/b", Some(2)).is_err());
        assert!(open_osseal(&ct, &key, "Dev/a", Some(3)).is_err());
    }

    #[test]
    fn entries_and_attachments_do_not_cross_open() {
        let key = ItemDataKey::generate();
        // An entry blob must not open as an attachment manifest...
        let entry = seal_osseal(b"secret", &key, "Dev/a", 1).unwrap();
        assert!(open_osseal_in(COLLECTION_ATTACHMENTS, &entry, &key, "Dev/a", Some(1)).is_err());
        // ...and a manifest blob must not open as an entry.
        let manifest = seal_osseal_in(COLLECTION_ATTACHMENTS, b"{}", &key, "Dev/a", 1).unwrap();
        assert!(open_osseal(&manifest, &key, "Dev/a", Some(1)).is_err());
    }

    #[test]
    fn envelope_revision_reads_without_a_key() {
        let key = ItemDataKey::generate();
        let ct = seal_osseal(b"secret", &key, "Dev/a", 4).unwrap();
        assert_eq!(envelope_revision(&ct).unwrap(), 4);
        assert!(envelope_revision(b"not an envelope").is_err());
    }
}
