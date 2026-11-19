//! Resource limits for untrusted sync input and local stores.

use std::{collections::BTreeMap, fmt};

use serde::{
    de::{self, SeqAccess, Visitor},
    Deserialize, Deserializer,
};

use crate::{ClientCoreError, SyncBlob, SyncCursor, MAX_SYNC_CIPHERTEXT_BYTES, MAX_SYNC_ID_BYTES};

/// Host currently admits at most 512 sync blobs per owner.
pub const MAX_SYNC_BLOBS: usize = 512;
/// Aggregate ciphertext kept by one local store or imported snapshot.
pub const MAX_SYNC_TOTAL_BYTES: usize = 32 * 1024 * 1024;
/// JSON encodes each byte as up to four characters, plus bounded metadata.
pub const MAX_SYNC_JSON_BYTES: usize = 129 * 1024 * 1024;
pub const MAX_SYNC_DEVICE_ID_BYTES: usize = 128;
pub const MAX_SYNC_PROJECT_ID_BYTES: usize = 128;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BoundedBlob {
    #[serde(deserialize_with = "deserialize_id")]
    id: String,
    epoch: u64,
    #[serde(deserialize_with = "deserialize_ciphertext")]
    ciphertext: Vec<u8>,
}

impl From<BoundedBlob> for SyncBlob {
    fn from(blob: BoundedBlob) -> Self {
        Self {
            id: blob.id,
            epoch: blob.epoch,
            ciphertext: blob.ciphertext,
        }
    }
}

#[derive(Deserialize)]
struct BoundedCursor {
    #[serde(deserialize_with = "deserialize_device_id")]
    device_id: String,
    epoch: u64,
}

pub(crate) fn deserialize_cursor<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<SyncCursor, D::Error> {
    let cursor = BoundedCursor::deserialize(deserializer)?;
    if cursor.epoch > i64::MAX as u64 {
        return Err(de::Error::custom(
            "sync cursor epoch exceeds the supported range",
        ));
    }
    Ok(SyncCursor {
        device_id: cursor.device_id,
        epoch: cursor.epoch,
    })
}

pub(crate) fn check_json_size(len: usize) -> Result<(), ClientCoreError> {
    if len > MAX_SYNC_JSON_BYTES {
        return Err(ClientCoreError::Persist(
            "sync JSON exceeds the input limit".into(),
        ));
    }
    Ok(())
}

pub(crate) fn validate_cursor(cursor: &SyncCursor) -> Result<(), ClientCoreError> {
    if cursor.device_id.is_empty()
        || cursor.device_id.len() > MAX_SYNC_DEVICE_ID_BYTES
        || cursor.epoch > i64::MAX as u64
    {
        return Err(ClientCoreError::Persist("invalid sync cursor".into()));
    }
    Ok(())
}

pub(crate) fn validate_blobs(blobs: &[SyncBlob]) -> Result<(), ClientCoreError> {
    if blobs.len() > MAX_SYNC_BLOBS {
        return Err(ClientCoreError::InvalidBlob("too many sync blobs"));
    }
    let mut total = 0usize;
    for blob in blobs {
        if blob.id.is_empty()
            || blob.id.len() > MAX_SYNC_ID_BYTES
            || blob.epoch == 0
            || blob.epoch > i64::MAX as u64
            || blob.ciphertext.is_empty()
            || blob.ciphertext.len() > MAX_SYNC_CIPHERTEXT_BYTES
        {
            return Err(ClientCoreError::InvalidBlob("invalid sync blob structure"));
        }
        total = total
            .checked_add(blob.ciphertext.len())
            .ok_or(ClientCoreError::InvalidBlob("sync byte limit exceeded"))?;
        if total > MAX_SYNC_TOTAL_BYTES {
            return Err(ClientCoreError::InvalidBlob("sync byte limit exceeded"));
        }
    }
    Ok(())
}

pub(crate) fn validate_capacity<'a>(
    entries: &'a BTreeMap<String, (u64, Vec<u8>)>,
    incoming: &'a [SyncBlob],
) -> Result<(), ClientCoreError> {
    validate_blobs(incoming)?;
    let mut projected: BTreeMap<&str, (u64, usize)> = entries
        .iter()
        .map(|(id, (epoch, ciphertext))| (id.as_str(), (*epoch, ciphertext.len())))
        .collect();
    for blob in incoming {
        if projected
            .get(blob.id.as_str())
            .is_none_or(|(epoch, _)| *epoch < blob.epoch)
        {
            projected.insert(&blob.id, (blob.epoch, blob.ciphertext.len()));
        }
    }
    if projected.len() > MAX_SYNC_BLOBS {
        return Err(ClientCoreError::InvalidBlob("too many sync blobs"));
    }
    let total = projected
        .values()
        .try_fold(0usize, |sum, (_, len)| sum.checked_add(*len))
        .ok_or(ClientCoreError::InvalidBlob("sync byte limit exceeded"))?;
    if total > MAX_SYNC_TOTAL_BYTES {
        return Err(ClientCoreError::InvalidBlob("sync byte limit exceeded"));
    }
    Ok(())
}

pub(crate) fn deserialize_id<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<String, D::Error> {
    bounded_string(deserializer, MAX_SYNC_ID_BYTES)
}

pub(crate) fn deserialize_device_id<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<String, D::Error> {
    bounded_string(deserializer, MAX_SYNC_DEVICE_ID_BYTES)
}

pub(crate) fn deserialize_format<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<String, D::Error> {
    bounded_string(deserializer, 64)
}

pub(crate) fn deserialize_project<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(transparent)]
    struct Project(#[serde(deserialize_with = "deserialize_project_value")] String);
    Option::<Project>::deserialize(deserializer).map(|value| value.map(|project| project.0))
}

fn deserialize_project_value<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<String, D::Error> {
    bounded_string(deserializer, MAX_SYNC_PROJECT_ID_BYTES)
}

pub(crate) fn deserialize_integrity<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(transparent)]
    struct Integrity(#[serde(deserialize_with = "deserialize_integrity_value")] String);
    Option::<Integrity>::deserialize(deserializer).map(|value| value.map(|tag| tag.0))
}

fn deserialize_integrity_value<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<String, D::Error> {
    bounded_string(deserializer, 64)
}

fn bounded_string<'de, D: Deserializer<'de>>(
    deserializer: D,
    limit: usize,
) -> Result<String, D::Error> {
    struct StringVisitor(usize);
    impl Visitor<'_> for StringVisitor {
        type Value = String;
        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            write!(f, "a nonempty string of at most {} bytes", self.0)
        }
        fn visit_str<E: de::Error>(self, value: &str) -> Result<String, E> {
            if value.is_empty() || value.len() > self.0 {
                return Err(E::custom("sync string length is invalid"));
            }
            Ok(value.to_owned())
        }
        fn visit_string<E: de::Error>(self, value: String) -> Result<String, E> {
            if value.is_empty() || value.len() > self.0 {
                return Err(E::custom("sync string length is invalid"));
            }
            Ok(value)
        }
    }
    deserializer.deserialize_string(StringVisitor(limit))
}

struct BytesVisitor;
impl<'de> Visitor<'de> for BytesVisitor {
    type Value = Vec<u8>;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("bounded ciphertext bytes")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Vec<u8>, A::Error> {
        if seq
            .size_hint()
            .is_some_and(|n| n > MAX_SYNC_CIPHERTEXT_BYTES)
        {
            return Err(de::Error::custom("sync ciphertext exceeds the byte limit"));
        }
        let mut bytes =
            Vec::with_capacity(seq.size_hint().unwrap_or(0).min(MAX_SYNC_CIPHERTEXT_BYTES));
        while let Some(byte) = seq.next_element::<u8>()? {
            if bytes.len() == MAX_SYNC_CIPHERTEXT_BYTES {
                return Err(de::Error::custom("sync ciphertext exceeds the byte limit"));
            }
            bytes.push(byte);
        }
        if bytes.is_empty() {
            return Err(de::Error::custom("empty sync ciphertext"));
        }
        Ok(bytes)
    }
    fn visit_bytes<E: de::Error>(self, bytes: &[u8]) -> Result<Vec<u8>, E> {
        if bytes.is_empty() || bytes.len() > MAX_SYNC_CIPHERTEXT_BYTES {
            return Err(E::custom("sync ciphertext length is invalid"));
        }
        Ok(bytes.to_vec())
    }
    fn visit_byte_buf<E: de::Error>(self, bytes: Vec<u8>) -> Result<Vec<u8>, E> {
        if bytes.is_empty() || bytes.len() > MAX_SYNC_CIPHERTEXT_BYTES {
            return Err(E::custom("sync ciphertext length is invalid"));
        }
        Ok(bytes)
    }
}

pub(crate) fn deserialize_ciphertext<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<u8>, D::Error> {
    deserializer.deserialize_seq(BytesVisitor)
}

struct BlobsVisitor;
impl<'de> Visitor<'de> for BlobsVisitor {
    type Value = Vec<SyncBlob>;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a bounded list of sync blobs")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Vec<SyncBlob>, A::Error> {
        if seq.size_hint().is_some_and(|n| n > MAX_SYNC_BLOBS) {
            return Err(de::Error::custom("too many sync blobs"));
        }
        let mut blobs = Vec::with_capacity(seq.size_hint().unwrap_or(0).min(MAX_SYNC_BLOBS));
        let mut total = 0usize;
        while let Some(blob) = seq.next_element::<BoundedBlob>()? {
            if blobs.len() == MAX_SYNC_BLOBS {
                return Err(de::Error::custom("too many sync blobs"));
            }
            let blob: SyncBlob = blob.into();
            total = total
                .checked_add(blob.ciphertext.len())
                .ok_or_else(|| de::Error::custom("sync byte limit exceeded"))?;
            if total > MAX_SYNC_TOTAL_BYTES {
                return Err(de::Error::custom("sync byte limit exceeded"));
            }
            blobs.push(blob);
        }
        Ok(blobs)
    }
}

pub(crate) fn deserialize_blobs<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<SyncBlob>, D::Error> {
    deserializer.deserialize_seq(BlobsVisitor)
}

#[cfg(test)]
#[path = "sync_limits_tests.rs"]
mod tests;
