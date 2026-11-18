//! `opensesame pass attach` — human CLI for sealed file attachments (ADR 0054).
//!
//! Attachments hold documents people care about losing and care about leaking:
//! tax paperwork, identity documents, scans. Two rules shape everything here.
//! Plaintext only ever leaves through [`crate::store::require_reveal`], so an
//! agent driving this binary cannot read a document out of the store. And
//! replication moves sealed bytes without opening them, so pushing a backup
//! never needs the passphrase.

use std::io::{self, Write};
use std::path::{Path, PathBuf};

use opensesame_sealed_store::{sanitize_filename, AttachMeta, StoreRoot};

use crate::store::{open_unlocked, require_reveal, shred_file};

/// Warn above this size that the free git-remote tier has a practical ceiling.
const LARGE_ATTACHMENT_WARN_BYTES: u64 = 50 * 1024 * 1024;

pub fn cmd_attach_add(
    name: &str,
    file: &Path,
    mime: Option<String>,
    force: bool,
    shred: bool,
    path: Option<&Path>,
    tomb: Option<&str>,
) -> anyhow::Result<()> {
    let meta = std::fs::metadata(file)?;
    if !meta.is_file() {
        anyhow::bail!(
            "{} is not a regular file; an attachment needs a known length up front",
            file.display()
        );
    }
    let total_bytes = meta.len();
    if total_bytes >= LARGE_ATTACHMENT_WARN_BYTES {
        eprintln!(
            "note: {} MiB attachment — git remotes have a soft repository ceiling around 5 GB; \
             consider an external attachment target for files this size",
            total_bytes / (1024 * 1024)
        );
    }
    let filename = file
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("attachment")
        .to_string();

    let (root, key) = open_unlocked(path, tomb)?;
    let mut source = std::fs::File::open(file)?;
    let summary = root
        .attach_add(
            name,
            &mut source,
            total_bytes,
            AttachMeta { filename, mime },
            &key,
            force,
        )
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    drop(source);

    if shred {
        shred_file(file)?;
    }
    println!(
        "sealed {} ({} bytes, {} chunk(s)) at {}",
        summary.filename, summary.total_bytes, summary.chunk_count, summary.name
    );
    Ok(())
}

pub fn cmd_attach_get(
    name: &str,
    out: Option<&Path>,
    reveal: bool,
    path: Option<&Path>,
    tomb: Option<&str>,
) -> anyhow::Result<()> {
    // Plaintext leaves the store on this path whether it lands on stdout or in
    // a file, so the reveal gate covers both.
    require_reveal(reveal)?;
    let (root, key) = open_unlocked(path, tomb)?;

    match out {
        None => {
            let mut stdout = io::stdout();
            root.attach_get(name, &mut stdout, &key)
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            stdout.flush()?;
        }
        Some(dest) => {
            let dest = resolve_output_path(&root, name, &key, dest)?;
            write_owner_only(&dest, |file| {
                root.attach_get(name, file, &key)
                    .map(drop)
                    .map_err(|e| anyhow::anyhow!("{e}"))
            })?;
            println!("wrote {}", dest.display());
        }
    }
    Ok(())
}

/// Write `dest` so that no one but its owner can ever read it.
///
/// `fill` writes into a fresh sibling `.partial` file that is created
/// exclusively (`O_EXCL`, so never through a planted symlink) at mode `0600` —
/// never at the umask's mode and chmodded afterwards — then it is synced and
/// renamed into place. A failure part way through removes the partial file,
/// so nothing truncated is ever left looking like the real document.
pub(crate) fn write_owner_only(
    dest: &Path,
    fill: impl FnOnce(&mut std::fs::File) -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    let tmp = dest.with_extension("partial");
    // A partial left by an earlier crash is ours to replace, never to reuse.
    match std::fs::remove_file(&tmp) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e.into()),
        _ => {}
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut partial = options.open(&tmp)?;
    let written = fill(&mut partial).and_then(|()| Ok(partial.sync_all()?));
    drop(partial);
    let placed = written.and_then(|()| Ok(std::fs::rename(&tmp, dest)?));
    if placed.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    placed
}

/// Expand a directory destination using the stored filename, which is display
/// metadata from the manifest and so must be sanitized before it names a file.
fn resolve_output_path(
    root: &StoreRoot,
    name: &str,
    key: &opensesame_sealed_store::ItemDataKey,
    dest: &Path,
) -> anyhow::Result<PathBuf> {
    if !dest.is_dir() {
        return Ok(dest.to_path_buf());
    }
    let summary = root
        .attach_ls(Some(name), key)
        .map_err(|e| anyhow::anyhow!("{e}"))?
        .into_iter()
        .find(|s| s.name == name)
        .ok_or_else(|| anyhow::anyhow!("attachment not found: {name}"))?;
    let safe = sanitize_filename(&summary.filename)
        .ok_or_else(|| anyhow::anyhow!("stored filename is unusable; pass an explicit --out"))?;
    Ok(dest.join(safe))
}

pub fn cmd_attach_ls(
    prefix: Option<&str>,
    path: Option<&Path>,
    tomb: Option<&str>,
) -> anyhow::Result<()> {
    let (root, key) = open_unlocked(path, tomb)?;
    let listed = root
        .attach_ls(prefix, &key)
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    if listed.is_empty() {
        println!("no attachments");
        return Ok(());
    }
    for summary in listed {
        println!(
            "{}\t{}\t{} bytes\t{} chunk(s)\t{}",
            summary.name, summary.filename, summary.total_bytes, summary.chunk_count, summary.mime
        );
    }
    Ok(())
}

pub fn cmd_attach_rm(name: &str, path: Option<&Path>, tomb: Option<&str>) -> anyhow::Result<()> {
    let (root, key) = open_unlocked(path, tomb)?;
    root.attach_rm(name, &key)
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    println!("removed {name}");
    eprintln!("note: git history still holds the old ciphertext — removal is not erasure");
    Ok(())
}

pub fn cmd_attach_gc(path: Option<&Path>, tomb: Option<&str>) -> anyhow::Result<()> {
    let (root, key) = open_unlocked(path, tomb)?;
    let outcome = root.attach_gc(&key).map_err(|e| anyhow::anyhow!("{e}"))?;
    println!(
        "removed {} orphan(s), kept {} referenced, skipped {} too recent to be sure",
        outcome.removed, outcome.kept, outcome.skipped_recent
    );
    Ok(())
}

#[path = "attach_sync.rs"]
mod sync;
pub use sync::cmd_attach_sync;
#[cfg(test)]
use sync::{
    attachment_host_origin, classify, sync_to_dir, sync_to_target_authorized, urlencoding_path,
    Unit,
};

#[cfg(test)]
#[path = "attach_tests.rs"]
mod tests;
