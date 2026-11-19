//! Chunked, content-addressed file attachments for the sealed store (ADR 0054).
//!
//! An attachment is stored as a set of independently sealed chunk objects plus
//! one sealed manifest. The manifest is the root of trust: it names the chunk
//! digests in order and carries the plaintext digest of the whole file, so a
//! reader never touches a chunk the manifest did not vouch for.
//!
//! Chunks are content-addressed by the BLAKE3 of their *ciphertext* frame. The
//! per-attachment key is derived from a fresh random attachment id, so two
//! attachments holding the same bytes seal to unrelated ciphertext and share no
//! digests — content addressing therefore leaks no equality between them. The
//! deliberate cost is that identical files are stored twice.
//!
//! Ordering matters for crash safety: chunks are written first and the manifest
//! last. A crash between the two leaves orphan objects, which are ciphertext
//! nobody references and which [`StoreRoot::attach_gc`] reclaims. The reverse
//! order would leave a manifest pointing at chunks that do not exist.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use opensesame_human_vault::{
    derive_attachment_key, open_chunk, seal_chunk, ChunkAd, ItemDataKey, ENVELOPE_VERSION,
};
use rand::Rng;
use serde::{Deserialize, Serialize};

use crate::envelope::{seal_osseal_in, COLLECTION_ATTACHMENTS};
use crate::git::auto_commit;
use crate::path::{
    confined_atomic_write, confined_read, confined_remove, confined_write, logical_to_relative,
};
use crate::{StoreError, StoreRoot};

#[path = "attachment_manifest_read.rs"]
mod manifest_read;
#[path = "attachment_recovery.rs"]
mod recovery;
pub(crate) use recovery::parse_attachment_manifest;

/// Plaintext bytes per chunk. Sealed, a chunk costs 48 bytes more than this —
/// far below the 100 MB per-file ceiling a git remote will accept.
pub const CHUNK_PLAINTEXT_BYTES: usize = 1_048_576;

/// Hard ceiling on one attachment (1 GiB, so at most 1024 chunks).
pub const MAX_ATTACHMENT_BYTES: u64 = 1 << 30;

/// Local revision state for manifests. Kept separate from the entry
/// revision map so an attachment name can never collide with an entry name.
pub const ATTACHMENT_REVISION_FILE: &str = ".opensesame-attachment-revisions.json";

/// Orphan objects younger than this are left alone, so a garbage collection
/// running beside an in-progress `attach_add` cannot reap its chunks before the
/// manifest that will reference them is written.
pub const GC_GRACE_SECONDS: u64 = 3600;

/// Extension of a sealed attachment manifest.
pub const ATTACH_EXT: &str = "osattach";

/// Extension of a sealed chunk object.
pub const CHUNK_EXT: &str = "oschunk";

/// Directory holding the content-addressed chunk objects. Dot-prefixed so the
/// entry walker, which skips dotted names, never descends into it.
const OBJECTS_DIR: &str = ".attachments/objects";

/// Manifest schema version.
const MANIFEST_FORMAT: u32 = 1;

/// Longest filename we will record. This is display metadata only, but it is
/// still attacker-influenced input that gets decoded on every read.
const MAX_FILENAME_BYTES: usize = 255;

/// What the caller knows about the file being attached.
pub struct AttachMeta {
    pub filename: String,
    pub mime: Option<String>,
}

/// One chunk as recorded in a manifest.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChunkRef {
    /// BLAKE3 of the sealed frame, lowercase hex.
    pub digest: String,
    pub ct_bytes: u64,
    pub pt_bytes: u64,
}

/// Sealed manifest plaintext.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AttachmentManifest {
    pub format: u32,
    pub attachment_id: String,
    pub filename: String,
    pub mime: String,
    pub total_bytes: u64,
    pub chunk_bytes: u64,
    pub chunk_count: u32,
    pub chunks: Vec<ChunkRef>,
    /// `blake3:<hex>` over the whole plaintext.
    pub content_digest: String,
    pub created_at_unix_ms: u64,
}

/// Metadata view of a stored attachment. Never carries file bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttachmentSummary {
    pub name: String,
    pub attachment_id: String,
    pub filename: String,
    pub mime: String,
    pub total_bytes: u64,
    pub chunk_count: u32,
    pub content_digest: String,
}

/// Result of a garbage collection pass.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GcOutcome {
    pub removed: usize,
    pub kept: usize,
    pub skipped_recent: usize,
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| saturating_millis(duration.as_millis()))
}

fn saturating_millis(millis: u128) -> u64 {
    u64::try_from(millis).unwrap_or(u64::MAX)
}

/// Guess a content type from the extension alone. Never sniff content: the
/// bytes are the user's document, and a sniffer is one more parser to attack.
fn mime_for(filename: &str) -> String {
    let ext = Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "tif" | "tiff" => "image/tiff",
        "txt" => "text/plain",
        "csv" => "text/csv",
        "json" => "application/json",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// Strip a recorded filename down to something safe to use as a local output
/// name. Returns `None` when nothing usable survives.
#[must_use]
pub fn sanitize_filename(filename: &str) -> Option<String> {
    let base = filename
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim()
        .trim_start_matches('.');
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control() && *c != '/' && *c != '\\' && *c != '\0')
        .collect();
    let cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        return None;
    }
    Some(cleaned)
}

pub(crate) fn object_relative(digest_hex: &str) -> Result<PathBuf, StoreError> {
    // The digest is produced by us from BLAKE3 output, but it also arrives from
    // a decrypted manifest, so validate before it reaches a path.
    if digest_hex.len() != 64 || !digest_hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(StoreError::InvalidPath("invalid chunk digest".into()));
    }
    let lowered = digest_hex.to_ascii_lowercase();
    Ok(PathBuf::from(OBJECTS_DIR)
        .join(&lowered[0..2])
        .join(format!("{lowered}.{CHUNK_EXT}")))
}

pub(crate) fn attach_relative(name: &str) -> Result<PathBuf, StoreError> {
    let rel = logical_to_relative(name)?;
    // Append rather than `with_extension`, matching entry naming so a dotted
    // logical name keeps its final label.
    let mut file = rel.into_os_string();
    file.push(".");
    file.push(ATTACH_EXT);
    Ok(PathBuf::from(file))
}

impl StoreRoot {
    pub(crate) fn attachment_revisions(&self) -> Result<BTreeMap<String, u64>, StoreError> {
        let path = self.path.join(ATTACHMENT_REVISION_FILE);
        if !path.exists() {
            return Ok(BTreeMap::new());
        }
        let raw = serde_json::from_slice(&confined_read(
            &self.path,
            Path::new(ATTACHMENT_REVISION_FILE),
        )?)
        .map_err(|e| StoreError::Crypto(format!("invalid attachment revision state: {e}")))?;
        Ok(crate::store::normalize_revisions(raw))
    }

    fn attachment_revision(&self, name: &str) -> Result<Option<u64>, StoreError> {
        crate::store::revision_for(&self.attachment_revisions()?, name)
    }

    fn record_attachment_revision(&self, name: &str, revision: u64) -> Result<(), StoreError> {
        let mut revisions = self.attachment_revisions()?;
        crate::store::set_revision(&mut revisions, name, revision)?;
        let bytes = serde_json::to_vec(&revisions)
            .map_err(|e| StoreError::Crypto(format!("attachment revision state: {e}")))?;
        confined_atomic_write(&self.path, Path::new(ATTACHMENT_REVISION_FILE), &bytes)
    }

    fn next_attachment_revision(
        &self,
        name: &str,
        key: &ItemDataKey,
        manifest_plaintext: Option<&[u8]>,
    ) -> Result<u64, StoreError> {
        let relative = attach_relative(name)?;
        let local = self.attachment_revision(name)?.unwrap_or(0);
        let next = self.advance_attachment_witness(
            name,
            &self.path.join(relative),
            key,
            local,
            manifest_plaintext,
            false,
        )?;
        self.record_attachment_revision(name, next)?;
        Ok(next)
    }

    /// Seal `source` into chunk objects plus a manifest filed at `name`.
    ///
    /// `total_bytes` must be the exact length of `source`; it fixes the chunk
    /// count, which is bound into every chunk's associated data and is what
    /// makes truncation detectable.
    ///
    /// # Errors
    ///
    /// Returns an error when the path or metadata is invalid, the declared
    /// length is unsupported or differs from the source, encryption fails, or
    /// ciphertext and revision state cannot be written and committed.
    pub fn attach_add(
        &self,
        name: &str,
        source: &mut dyn Read,
        total_bytes: u64,
        meta: AttachMeta,
        key: &ItemDataKey,
        force: bool,
    ) -> Result<AttachmentSummary, StoreError> {
        if total_bytes > MAX_ATTACHMENT_BYTES {
            return Err(StoreError::Crypto(format!(
                "attachment is {total_bytes} bytes, over the {MAX_ATTACHMENT_BYTES} byte limit"
            )));
        }
        if meta.filename.len() > MAX_FILENAME_BYTES {
            return Err(StoreError::InvalidPath("filename too long".into()));
        }
        let rel = attach_relative(name)?;
        let _lock = crate::store_lock::StoreLock::for_sealing(&self.path, name, key)?;
        if !force && self.path.join(&rel).exists() {
            return Err(StoreError::AlreadyExists(name.into()));
        }
        if self.path.join(&rel).exists() {
            self.attachment_witness(name, key)?;
        }
        self.attachment_witness_ready(key)?;

        let mut id_bytes = [0u8; 16];
        rand::rng().fill_bytes(&mut id_bytes);
        let attachment_id = hex_lower(&id_bytes);
        let attachment_key = derive_attachment_key(key, &id_bytes);

        let chunk_size = u64::try_from(CHUNK_PLAINTEXT_BYTES)
            .map_err(|_| StoreError::Crypto("chunk size exceeds the supported range".into()))?;
        let chunk_count = chunk_count_for(total_bytes, chunk_size)?;

        let chunk_capacity = usize::try_from(chunk_count)
            .map_err(|_| StoreError::Crypto("chunk count exceeds platform capacity".into()))?;
        let mut chunks: Vec<ChunkRef> = Vec::with_capacity(chunk_capacity);
        let mut content = blake3::Hasher::new();
        let mut written: u64 = 0;
        let mut buffer = vec![0u8; CHUNK_PLAINTEXT_BYTES];

        for chunk_index in 0..chunk_count {
            let remaining = total_bytes - written;
            let want = usize::try_from(remaining.min(chunk_size))
                .map_err(|_| StoreError::Crypto("chunk length exceeds platform capacity".into()))?;
            read_exact_chunk(source, &mut buffer[..want])?;
            let plaintext = &buffer[..want];
            content.update(plaintext);

            let ad = ChunkAd {
                envelope_version: ENVELOPE_VERSION,
                attachment_id: attachment_id.clone(),
                item_id: name.to_string(),
                chunk_index,
                chunk_count,
            };
            let frame = seal_chunk(&attachment_key, plaintext, &ad)
                .map_err(|e| StoreError::Crypto(e.to_string()))?;
            let digest = blake3::hash(&frame).to_hex().to_string();
            let object_rel = object_relative(&digest)?;
            // Content-addressed: an identical frame is already the same bytes,
            // so re-writing it would be busywork.
            if !self.path.join(&object_rel).exists() {
                confined_write(&self.path, &object_rel, &frame)?;
            }
            chunks.push(ChunkRef {
                digest,
                ct_bytes: frame.len() as u64,
                pt_bytes: want as u64,
            });
            written += want as u64;
        }

        // Refuse a source that under-delivered: the chunk count is already
        // sealed into every frame, so a short read would produce an attachment
        // that can never be reassembled.
        if written != total_bytes {
            return Err(StoreError::Crypto(format!(
                "source yielded {written} bytes, expected {total_bytes}"
            )));
        }
        // And refuse one that has more to give than it declared.
        let mut extra = [0u8; 1];
        if source.read(&mut extra).unwrap_or(0) != 0 {
            return Err(StoreError::Crypto(
                "source is longer than the declared length".into(),
            ));
        }

        let manifest = AttachmentManifest {
            format: MANIFEST_FORMAT,
            attachment_id: attachment_id.clone(),
            filename: meta.filename.clone(),
            mime: meta.mime.unwrap_or_else(|| mime_for(&meta.filename)),
            total_bytes,
            chunk_bytes: chunk_size,
            chunk_count,
            chunks,
            content_digest: format!("blake3:{}", content.finalize().to_hex()),
            created_at_unix_ms: now_unix_ms(),
        };

        let plaintext = serde_json::to_vec(&manifest)
            .map_err(|e| StoreError::Crypto(format!("manifest encode: {e}")))?;
        let revision = self.next_attachment_revision(name, key, Some(&plaintext))?;
        let sealed = seal_osseal_in(COLLECTION_ATTACHMENTS, &plaintext, key, name, revision)?;
        confined_atomic_write(&self.path, &rel, &sealed)?;

        auto_commit(&self.path, crate::store::COMMIT_ATTACH)?;
        Ok(summary_of(name, &manifest))
    }

    pub(crate) fn open_manifest(
        &self,
        name: &str,
        key: &ItemDataKey,
    ) -> Result<(AttachmentManifest, String), StoreError> {
        self.open_manifest_at_witness(name, key)
    }

    /// Reassemble an attachment into `sink`.
    ///
    /// # Errors
    ///
    /// Returns an error when the manifest or chunk paths are invalid, stored
    /// ciphertext is missing or inconsistent, authentication fails, or the
    /// plaintext cannot be written to `sink`.
    pub fn attach_get(
        &self,
        name: &str,
        sink: &mut dyn Write,
        key: &ItemDataKey,
    ) -> Result<AttachmentSummary, StoreError> {
        let (manifest, bound_name) = self.open_manifest_for_read(name, key)?;
        let mut id_bytes = [0u8; 16];
        hex_to_bytes(&manifest.attachment_id, &mut id_bytes)?;
        let attachment_key = derive_attachment_key(key, &id_bytes);

        let mut content = blake3::Hasher::new();
        let mut written: u64 = 0;
        for (index, chunk) in manifest.chunks.iter().enumerate() {
            let object_rel = object_relative(&chunk.digest)?;
            let frame = confined_read(&self.path, &object_rel)?;
            // Verify the content address before handing the frame to the AEAD:
            // a mismatch means the object pool was tampered with, and that is
            // worth reporting as such rather than as a decrypt failure.
            if blake3::hash(&frame).to_hex().to_string() != chunk.digest {
                return Err(StoreError::Crypto(format!(
                    "chunk {index} does not match its content address"
                )));
            }
            if frame.len() as u64 != chunk.ct_bytes {
                return Err(StoreError::Crypto(format!(
                    "chunk {index} has unexpected ciphertext length"
                )));
            }
            let chunk_index = u32::try_from(index).map_err(|_| {
                StoreError::Crypto("chunk index exceeds the supported range".into())
            })?;
            let ad = ChunkAd {
                envelope_version: ENVELOPE_VERSION,
                attachment_id: manifest.attachment_id.clone(),
                item_id: bound_name.clone(),
                chunk_index,
                chunk_count: manifest.chunk_count,
            };
            let plaintext = open_chunk(&attachment_key, &frame, &ad)
                .map_err(|e| StoreError::Crypto(e.to_string()))?;
            if plaintext.len() as u64 != chunk.pt_bytes {
                return Err(StoreError::Crypto(format!(
                    "chunk {index} has unexpected plaintext length"
                )));
            }
            content.update(&plaintext);
            written += plaintext.len() as u64;
            sink.write_all(&plaintext)?;
        }

        if written != manifest.total_bytes {
            return Err(StoreError::Crypto("reassembled size mismatch".into()));
        }
        let digest = format!("blake3:{}", content.finalize().to_hex());
        if digest != manifest.content_digest {
            return Err(StoreError::Crypto(
                "reassembled content digest mismatch".into(),
            ));
        }
        sink.flush()?;
        Ok(summary_of(name, &manifest))
    }

    /// List attachment metadata, optionally filtered by logical-name prefix.
    ///
    /// # Errors
    ///
    /// Returns an error when attachment discovery or manifest validation fails.
    pub fn attach_ls(
        &self,
        prefix: Option<&str>,
        key: &ItemDataKey,
    ) -> Result<Vec<AttachmentSummary>, StoreError> {
        let _lock = crate::store_lock::StoreLock::exclusive_for_key(&self.path, key)?;
        let names = self.attachment_names()?;
        self.verify_attachment_inventory(key, &names.iter().cloned().collect())?;
        let mut out = Vec::new();
        for name in names {
            if prefix.is_some_and(|prefix| !name.starts_with(prefix)) {
                continue;
            }
            let manifest = self.open_manifest_locked(&name, key)?;
            out.push(summary_of(&name, &manifest));
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    /// Remove an attachment's manifest and reclaim whatever it alone held.
    ///
    /// This is not erasure: the ciphertext stays in git history.
    ///
    /// # Errors
    ///
    /// Returns an error when the attachment does not exist, path-confined
    /// removal or revision persistence fails, garbage collection cannot prove
    /// an object is orphaned, or the Git auto-commit fails.
    pub fn attach_rm(&self, name: &str, key: &ItemDataKey) -> Result<(), StoreError> {
        let rel = attach_relative(name)?;
        let _lock = crate::store_lock::StoreLock::for_sealing(&self.path, name, key)?;
        if !self.path.join(&rel).exists() {
            return Err(StoreError::NotFound(name.into()));
        }
        // Advance the local counter before unlink, including when this clone
        // has no sidecar yet. Retrying is safe if unlink is interrupted.
        let local = self.attachment_revision(name)?;
        if local.is_none() && !self.attachment_witness(name, key)?.deleted {
            self.open_manifest_at_witness(name, key)?;
        }
        let revision = self.tombstone_attachment_witness(name, key, local.unwrap_or(0))?;
        self.record_attachment_revision(name, revision)?;
        confined_remove(&self.path, &rel)?;
        self.collect_garbage(key)?;
        auto_commit(&self.path, crate::store::COMMIT_DETACH)?;
        Ok(())
    }

    /// Reclaim chunk objects no manifest references.
    ///
    /// # Errors
    ///
    /// Returns an error when any manifest cannot be authenticated, object
    /// discovery or removal fails, or the Git auto-commit fails.
    pub fn attach_gc(&self, key: &ItemDataKey) -> Result<GcOutcome, StoreError> {
        let _lock = crate::store_lock::StoreLock::key_file_edit(&self.path)?;
        let outcome = self.collect_garbage(key)?;
        if outcome.removed > 0 {
            auto_commit(&self.path, "GC attachments")?;
        }
        Ok(outcome)
    }

    fn collect_garbage(&self, key: &ItemDataKey) -> Result<GcOutcome, StoreError> {
        // Build the referenced set from every manifest. If even one manifest
        // cannot be opened we do not know what it protects, so we remove
        // nothing rather than risk deleting live chunks.
        let mut referenced: BTreeSet<String> = BTreeSet::new();
        let names = self.attachment_names()?;
        self.verify_attachment_inventory(key, &names.iter().cloned().collect())?;
        for name in names {
            let manifest = self.open_manifest_locked(&name, key).map_err(|e| {
                StoreError::Crypto(format!(
                    "refusing to collect garbage: manifest {name} could not be opened ({e})"
                ))
            })?;
            for chunk in &manifest.chunks {
                referenced.insert(chunk.digest.to_ascii_lowercase());
            }
        }

        let mut outcome = GcOutcome {
            removed: 0,
            kept: 0,
            skipped_recent: 0,
        };
        let now = SystemTime::now();
        for (digest, rel) in self.object_files()? {
            if referenced.contains(&digest) {
                outcome.kept += 1;
                continue;
            }
            // An orphan may belong to an attach that is still running.
            let age_ok = std::fs::metadata(self.path.join(&rel))
                .and_then(|m| m.modified())
                .ok()
                .and_then(|m| now.duration_since(m).ok())
                .is_some_and(|age| age.as_secs() >= GC_GRACE_SECONDS);
            if !age_ok {
                outcome.skipped_recent += 1;
                continue;
            }
            confined_remove(&self.path, &rel)?;
            outcome.removed += 1;
        }
        Ok(outcome)
    }

    /// Every ciphertext file replication needs, without opening any of it.
    ///
    /// Returns `(relative path, absolute path)` pairs covering all manifests
    /// and all chunk objects. Orphans are included: they are ciphertext, and
    /// copying a few extra is cheaper than requiring a passphrase here.
    ///
    /// # Errors
    ///
    /// Returns an error when manifest or object discovery encounters an invalid
    /// path or filesystem failure.
    pub fn attach_replication_units(&self) -> Result<Vec<(String, PathBuf)>, StoreError> {
        let mut units: Vec<(String, PathBuf)> = Vec::new();
        for name in self.attachment_names()? {
            let rel = attach_relative(&name)?;
            units.push((rel.to_string_lossy().into_owned(), self.path.join(&rel)));
        }
        for (_, rel) in self.object_files()? {
            units.push((rel.to_string_lossy().into_owned(), self.path.join(&rel)));
        }
        units.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(units)
    }

    /// Logical names of every stored attachment, sorted.
    ///
    /// This is the rotation's own inventory, so listing, garbage collection,
    /// replication and rotation all see one set: a dot-named attachment
    /// (`Dev/.w2`) is legal, and a walker that hid it would let GC reclaim its
    /// chunks and replication leave it behind. The walk fails closed (a
    /// symlink, an unreadable directory, a name the store cannot address), so
    /// GC deletes nothing when it cannot account for every manifest.
    pub(crate) fn attachment_names(&self) -> Result<Vec<String>, StoreError> {
        let inventory = crate::rotation_walk::inventory(&self.path)?;
        Ok(inventory.attachments.into_iter().collect())
    }

    /// `(digest, relative path)` for every chunk object in the pool.
    pub(crate) fn object_files(&self) -> Result<Vec<(String, PathBuf)>, StoreError> {
        let mut out = Vec::new();
        let root = self.path.join(OBJECTS_DIR);
        let shards = match std::fs::read_dir(&root) {
            Ok(shards) => shards,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
            Err(e) => return Err(StoreError::Io(e)),
        };
        for shard in shards {
            let shard = shard.map_err(StoreError::Io)?;
            if !shard.file_type().map_err(StoreError::Io)?.is_dir() {
                continue;
            }
            collect_shard_objects(&shard, &mut out)?;
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(out)
    }
}

fn chunk_count_for(total_bytes: u64, chunk_size: u64) -> Result<u32, StoreError> {
    if chunk_size == 0 {
        return Err(StoreError::Crypto("chunk size must be non-zero".into()));
    }
    u32::try_from(total_bytes.div_ceil(chunk_size))
        .map_err(|_| StoreError::Crypto("attachment needs too many chunks".into()))
}

fn collect_shard_objects(
    shard: &std::fs::DirEntry,
    out: &mut Vec<(String, PathBuf)>,
) -> Result<(), StoreError> {
    for object in std::fs::read_dir(shard.path()).map_err(StoreError::Io)? {
        let object = object.map_err(StoreError::Io)?;
        if let Some(reference) = object_reference(shard, &object)? {
            out.push(reference);
        }
    }
    Ok(())
}

fn object_reference(
    shard: &std::fs::DirEntry,
    object: &std::fs::DirEntry,
) -> Result<Option<(String, PathBuf)>, StoreError> {
    if !object.file_type().map_err(StoreError::Io)?.is_file() {
        return Ok(None);
    }
    let file_name = object.file_name();
    let Some(file_name) = file_name.to_str() else {
        return Ok(None);
    };
    let suffix = format!(".{CHUNK_EXT}");
    let Some(digest) = file_name.strip_suffix(&suffix) else {
        return Ok(None);
    };
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Ok(None);
    }
    let rel = PathBuf::from(OBJECTS_DIR)
        .join(shard.file_name())
        .join(file_name);
    Ok(Some((digest.to_ascii_lowercase(), rel)))
}

fn summary_of(name: &str, manifest: &AttachmentManifest) -> AttachmentSummary {
    AttachmentSummary {
        name: name.to_string(),
        attachment_id: manifest.attachment_id.clone(),
        filename: manifest.filename.clone(),
        mime: manifest.mime.clone(),
        total_bytes: manifest.total_bytes,
        chunk_count: manifest.chunk_count,
        content_digest: manifest.content_digest.clone(),
    }
}

/// Read exactly `buf.len()` bytes, treating a short stream as an error.
fn read_exact_chunk(source: &mut dyn Read, buf: &mut [u8]) -> Result<(), StoreError> {
    let mut filled = 0;
    while filled < buf.len() {
        match source.read(&mut buf[filled..]) {
            Ok(0) => {
                return Err(StoreError::Crypto(
                    "source ended before the declared length".into(),
                ))
            }
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(StoreError::Io(e)),
        }
    }
    Ok(())
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(HEX[usize::from(byte >> 4)]));
        out.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    out
}

pub(crate) fn hex_to_bytes(hex: &str, out: &mut [u8; 16]) -> Result<(), StoreError> {
    if hex.len() != 32 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(StoreError::Crypto("invalid attachment id".into()));
    }
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)
            .map_err(|_| StoreError::Crypto("invalid attachment id".into()))?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "attachment_revision_tests.rs"]
mod revision_tests;

#[cfg(test)]
#[path = "attachment_inventory_tests.rs"]
mod inventory_tests;

#[cfg(test)]
#[path = "attachment_pact_fixture.rs"]
mod pact_fixture;
#[cfg(test)]
#[path = "attachment_pact_property_tests.rs"]
mod pact_property;
#[cfg(test)]
#[path = "attachment_pact_stress_tests.rs"]
mod pact_stress;
