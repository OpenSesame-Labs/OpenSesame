//! Authenticated identity and ordering metadata for sync blobs.

use zeroize::Zeroizing;

use crate::{open, seal, ClientCoreError, DeviceKey, SyncBlob};

const MAGIC: &[u8] = b"OS-SYNC2";
const AAD_DOMAIN: &[u8] = b"OpenSesame client sync blob v2\0";
/// Match the Host's existing per-blob admission limits.
pub const MAX_SYNC_ID_BYTES: usize = 128;
pub const MAX_SYNC_CIPHERTEXT_BYTES: usize = 2 * 1024 * 1024;
const ENVELOPE_OVERHEAD: usize = MAGIC.len() + 24 + 16;

fn aad(id: &str, epoch: u64) -> Vec<u8> {
    let mut value = Vec::with_capacity(AAD_DOMAIN.len() + 8 + id.len() + 8);
    value.extend_from_slice(AAD_DOMAIN);
    value.extend_from_slice(&(id.len() as u64).to_be_bytes());
    value.extend_from_slice(id.as_bytes());
    value.extend_from_slice(&epoch.to_be_bytes());
    value
}

pub(crate) fn validate_blob(blob: &SyncBlob) -> Result<(), ClientCoreError> {
    if blob.id.is_empty() || blob.id.len() > MAX_SYNC_ID_BYTES {
        return Err(ClientCoreError::InvalidBlob("invalid sync id"));
    }
    if blob.epoch == 0 || blob.epoch > i64::MAX as u64 {
        return Err(ClientCoreError::InvalidBlob("invalid sync epoch"));
    }
    if blob.ciphertext.len() < ENVELOPE_OVERHEAD
        || blob.ciphertext.len() > MAX_SYNC_CIPHERTEXT_BYTES
        || !blob.ciphertext.starts_with(MAGIC)
    {
        return Err(ClientCoreError::InvalidBlob(
            "unsupported or oversized sync envelope",
        ));
    }
    Ok(())
}

pub(crate) fn seal_blob(
    key: &DeviceKey,
    id: String,
    epoch: u64,
    plaintext: &[u8],
) -> Result<SyncBlob, ClientCoreError> {
    if plaintext.len() > MAX_SYNC_CIPHERTEXT_BYTES - ENVELOPE_OVERHEAD {
        return Err(ClientCoreError::InvalidBlob(
            "sync plaintext exceeds the blob limit",
        ));
    }
    let mut blob = SyncBlob {
        id,
        epoch,
        ciphertext: MAGIC.to_vec(),
    };
    // Validate the identity and epoch before asking the AEAD to allocate.
    if blob.id.is_empty()
        || blob.id.len() > MAX_SYNC_ID_BYTES
        || epoch == 0
        || epoch > i64::MAX as u64
    {
        return Err(ClientCoreError::InvalidBlob(
            "invalid sync identity or epoch",
        ));
    }
    blob.ciphertext
        .extend(seal(key, plaintext, &aad(&blob.id, epoch))?);
    Ok(blob)
}

/// Open a versioned sync blob after authenticating its ID and epoch.
///
/// # Errors
///
/// Returns an error for a legacy, malformed, modified, or foreign-key blob.
pub fn open_sync_blob(key: &DeviceKey, blob: &SyncBlob) -> Result<Vec<u8>, ClientCoreError> {
    validate_blob(blob)?;
    open(
        key,
        &blob.ciphertext[MAGIC.len()..],
        &aad(&blob.id, blob.epoch),
    )
}

pub(crate) fn verify_blob(key: &DeviceKey, blob: &SyncBlob) -> Result<(), ClientCoreError> {
    let _plaintext = Zeroizing::new(open_sync_blob(key, blob)?);
    Ok(())
}
