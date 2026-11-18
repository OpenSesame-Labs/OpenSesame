//! Passphrase-free, client-driven attachment synchronization.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::store::resolve_root;
use opensesame_sealed_store::{verify_replication_chunk, StoreRoot, CHUNK_PLAINTEXT_BYTES};

#[path = "attachment_transport.rs"]
mod transport;

/// Keep manifest names and ciphertext in an owner-private temporary directory.
/// Windows additionally pins a private-ACL child until the sync finishes.
struct SnapshotScratch {
    #[cfg(windows)]
    _private_guard:
        opensesame_human_vault::root_protection::windows_private_files::PrivateDirectory,
    directory: tempfile::TempDir,
    #[cfg(windows)]
    private_dir: PathBuf,
}

impl SnapshotScratch {
    #[cfg(any(unix, windows))]
    fn new() -> anyhow::Result<Self> {
        let mut builder = tempfile::Builder::new();
        builder.prefix("opensesame-attachment-snapshot-");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // Default tempdir permissions may be world-readable or writable.
            builder.permissions(std::fs::Permissions::from_mode(0o700));
        }
        let directory = builder.tempdir()?;
        #[cfg(windows)]
        let private_dir = directory.path().join("sealed-manifests");
        #[cfg(windows)]
        let private_guard = opensesame_human_vault::root_protection::windows_private_files::PrivateDirectory::create_new(&private_dir)?;
        Ok(Self {
            #[cfg(windows)]
            _private_guard: private_guard,
            directory,
            #[cfg(windows)]
            private_dir,
        })
    }

    #[cfg(not(any(unix, windows)))]
    fn new() -> anyhow::Result<Self> {
        anyhow::bail!("private attachment snapshot directories are unsupported on this platform")
    }

    fn path(&self) -> &Path {
        #[cfg(windows)]
        {
            &self.private_dir
        }
        #[cfg(not(windows))]
        {
            self.directory.path()
        }
    }
}

/// Split a replication-unit path into what the gateway needs to file it.
///
/// Manifests are addressed by their logical store path, chunks by digest, so
/// the two take different endpoints. Anything else in the store is not ours to
/// replicate.
pub(super) enum Unit {
    Manifest { logical: String },
    Chunk { digest: String },
}

pub(super) fn classify(relative: &str) -> Option<Unit> {
    if let Some(stem) = relative.strip_suffix(".osattach") {
        let logical = stem.replace('\\', "/");
        return (!logical.is_empty()).then_some(Unit::Manifest { logical });
    }
    if relative.ends_with(".oschunk") {
        let digest = std::path::Path::new(relative)
            .file_stem()
            .and_then(|s| s.to_str())?
            .to_string();
        let looks_like_a_digest =
            digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit());
        return looks_like_a_digest.then_some(Unit::Chunk { digest });
    }
    None
}

pub async fn cmd_attach_sync(
    to_dir: Option<&Path>,
    server: &str,
    path: Option<&Path>,
    tomb: Option<&str>,
) -> anyhow::Result<()> {
    // Replication moves sealed bytes only, so it never needs the passphrase.
    let root_path = resolve_root(path, tomb)?;
    let root = StoreRoot::open(&root_path).map_err(|e| anyhow::anyhow!("{e}"))?;
    // Copy only sealed manifests into private scratch while the store holds a
    // read lock. Content-addressed chunks are verified when read below.
    let scratch = SnapshotScratch::new()?;
    let units = root
        .attach_replication_snapshot(scratch.path())
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    if units.is_empty() {
        println!("no attachment ciphertext to replicate");
        return Ok(());
    }

    match to_dir {
        Some(dir) => sync_to_dir(&units, dir),
        None => sync_to_target(&units, server).await,
    }
}

/// Copy ciphertext to a mounted encrypted volume. No gateway, no ceremony.
pub(super) fn sync_to_dir(
    units: &[(String, PathBuf)],
    dir: &std::path::Path,
) -> anyhow::Result<()> {
    let mut copied = 0usize;
    for (rel, source, unit) in replication_order(units)? {
        let body = read_replication_unit(&unit, source)?;
        let dest = dir.join("attachments").join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // A unique private sibling prevents a failed write from truncating an
        // existing backup or replacing an unrelated fixed-name partial file.
        let parent = dest
            .parent()
            .ok_or_else(|| anyhow::anyhow!("invalid destination"))?;
        let mut temporary = tempfile::Builder::new()
            .prefix(".opensesame-attachment-")
            .tempfile_in(parent)?;
        temporary.write_all(&body)?;
        temporary.as_file().sync_all()?;
        temporary.persist(&dest).map_err(|error| error.error)?;
        copied += 1;
    }
    println!(
        "replicated {copied} ciphertext file(s) to {}",
        dir.display()
    );
    Ok(())
}

fn replication_order(
    units: &[(String, PathBuf)],
) -> anyhow::Result<Vec<(&String, &PathBuf, Unit)>> {
    let mut ordered: Vec<_> = units
        .iter()
        .map(|(rel, source)| {
            classify(rel)
                .map(|unit| (rel, source, unit))
                .ok_or_else(|| anyhow::anyhow!("unrecognized attachment replication unit: {rel}"))
        })
        .collect::<anyhow::Result<_>>()?;
    // Never publish a manifest until every inventoried chunk has succeeded.
    ordered.sort_by_key(|(_, _, unit)| matches!(unit, Unit::Manifest { .. }));
    Ok(ordered)
}

fn read_replication_unit(unit: &Unit, source: &Path) -> anyhow::Result<Vec<u8>> {
    // A sealed chunk has at most one plaintext chunk and 48 bytes of framing;
    // the gateway's manifest ceiling is one MiB. Read one extra byte to reject
    // oversized or substituted files without unbounded allocation.
    let limit = match unit {
        Unit::Chunk { .. } => CHUNK_PLAINTEXT_BYTES + 48,
        Unit::Manifest { .. } => 1_048_576,
    };
    let mut body = Vec::new();
    std::fs::File::open(source)?
        .take(u64::try_from(limit + 1)?)
        .read_to_end(&mut body)?;
    anyhow::ensure!(
        !body.is_empty() && body.len() <= limit,
        "invalid replication file size: {}",
        source.display()
    );
    if let Unit::Chunk { digest } = unit {
        anyhow::ensure!(
            verify_replication_chunk(digest, &body),
            "attachment chunk does not match its digest: {}",
            source.display()
        );
    }
    Ok(body)
}

/// Push ciphertext through the gateway to the configured provider target.
///
/// The gateway injects the provider credential; this side never sees it, and
/// the gateway never sees a store key. Uploads are idempotent by construction
/// (digest-addressed, overwrite mode), so a re-run after a partial failure is
/// safe.
async fn sync_to_target(units: &[(String, PathBuf)], server: &str) -> anyhow::Result<()> {
    let base = attachment_host_origin(server)?;
    let token = crate::operator_token()?;
    sync_to_target_authorized(units, &base, &token).await
}

/// A credential must only be sent to the selected Host origin, over TLS or a
/// loopback HTTP connection. In particular, reject URL userinfo and paths.
pub(super) fn attachment_host_origin(raw: &str) -> anyhow::Result<String> {
    let url = reqwest::Url::parse(raw)?;
    let local = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    let origin = url.origin().ascii_serialization();
    anyhow::ensure!(
        url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url.path() == "/"
            && (raw == origin || raw == format!("{origin}/"))
            && (url.scheme() == "https" || (url.scheme() == "http" && local)),
        "Host must be an exact HTTPS or loopback HTTP origin"
    );
    Ok(origin)
}

pub(super) async fn sync_to_target_authorized(
    units: &[(String, PathBuf)],
    base: &str,
    token: &str,
) -> anyhow::Result<()> {
    let client = transport::operator_client(base)?;

    // Fail before uploading anything if there is nowhere to put it.
    let target = transport::get_target(&client, base, token).await?;
    if target.get("target").is_none_or(serde_json::Value::is_null) {
        anyhow::bail!(
            "no attachment target configured; set one with PUT {base}/api/v1/attachments/target, \
             or use --to-dir to copy ciphertext to a mounted encrypted volume"
        );
    }
    let version = target["target"]["replication_version"]
        .as_str()
        .filter(|value| value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| {
            anyhow::anyhow!("attachment target does not identify its current configuration")
        })?;

    let mut uploaded = 0usize;
    for (rel, source, unit) in replication_order(units)? {
        let body = read_replication_unit(&unit, source)?;
        let url = match &unit {
            Unit::Chunk { digest } => {
                format!("{base}/api/v1/attachments/replicate/chunk?digest={digest}")
            }
            Unit::Manifest { logical } => format!(
                "{base}/api/v1/attachments/replicate/manifest?path={}",
                urlencoding_path(logical)
            ),
        };
        match transport::upload(&client, &url, token, version, body).await {
            Ok(()) => {
                uploaded += 1;
                println!("uploaded {rel}");
            }
            Err(error) => {
                anyhow::bail!("failed {rel}: {error}");
            }
        }
    }
    println!("replicated {uploaded} file(s)");
    Ok(())
}

/// Percent-encode the few characters that would otherwise change a query
/// string's shape. Store-logical paths are already restricted to safe
/// characters, so this is a belt on top of braces.
pub(super) fn urlencoding_path(value: &str) -> String {
    value
        .chars()
        .map(|c| match c {
            '&' => "%26".to_string(),
            '#' => "%23".to_string(),
            '?' => "%3F".to_string(),
            '+' => "%2B".to_string(),
            ' ' => "%20".to_string(),
            '%' => "%25".to_string(),
            other => other.to_string(),
        })
        .collect()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn snapshot_scratch_is_owner_only_at_creation_and_removed_on_drop() {
        let scratch = SnapshotScratch::new().unwrap();
        let path = scratch.path().to_path_buf();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o077, 0);
        drop(scratch);
        assert!(!path.exists());
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use opensesame_human_vault::root_protection::windows_private_files::PrivateDirectory;

    #[test]
    fn snapshot_scratch_has_a_verified_private_acl_and_is_removed() {
        let scratch = SnapshotScratch::new().unwrap();
        let path = scratch.path().to_path_buf();
        drop(PrivateDirectory::open(&path).unwrap());
        drop(scratch);
        assert!(!path.exists());
    }
}
