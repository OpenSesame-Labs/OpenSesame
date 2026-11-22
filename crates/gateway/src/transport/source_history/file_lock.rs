//! Cooperative process-lifetime lease acquired before opening a Host pool.
//!
//! The private sibling lock serializes current Hosts and the offline history
//! initializer using the same supported database path. The lease is retained
//! until process exit: canceled `SQLx` workers must not outlive the lock. This
//! does not fence raw `SQLite` users, older binaries, file-only bind aliases,
//! replacement of trusted resources, or restoration of an older database.

use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    os::unix::fs::MetadataExt,
    sync::{Arc, Mutex, OnceLock},
};

use sqlx::sqlite::SqliteConnectOptions;

#[cfg(unix)]
use opensesame_human_vault::root_protection::unix_private_files::{
    HeldPrivateWriterLease, PrivateDirectory,
};
#[cfg(unix)]
const LOCK_DIRECTORY: &str = ".opensesame-host-leases-v1";
#[cfg(unix)]
const MAX_PROCESS_DATABASES: usize = 256;

#[cfg(unix)]
struct ProcessLease {
    database: File,
    _lease: HeldPrivateWriterLease,
}

#[cfg(unix)]
static OWNERS: OnceLock<Mutex<BTreeMap<String, ProcessLease>>> = OnceLock::new();

/// Parse a supported `SQLite` URL and, for a file, retain its cooperative lock.
/// `None` is a genuine in-memory database and has no cross-process file owner.
pub(crate) fn claim_url(
    url: &str,
    allow_memory: bool,
    allow_creation: bool,
) -> anyhow::Result<Option<SqliteConnectOptions>> {
    let raw = url
        .strip_prefix("sqlite://")
        .or_else(|| url.strip_prefix("sqlite:"))
        .unwrap_or(url);
    let (database, query) = raw.split_once('?').unwrap_or((raw, ""));
    if database.starts_with("file:") || database.starts_with("sqlite:") {
        anyhow::bail!("unsupported nested SQLite URI");
    }
    let mut mode = None;
    let mut cache = None;
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        match key.as_ref() {
            "mode" if mode.is_none() => mode = Some(value.into_owned()),
            "cache" if cache.is_none() => cache = Some(value.into_owned()),
            _ => anyhow::bail!("unsupported or repeated SQLite URL option"),
        }
    }
    if mode
        .as_deref()
        .is_some_and(|value| !["ro", "rw", "rwc", "memory"].contains(&value))
        || cache
            .as_deref()
            .is_some_and(|value| !["private", "shared"].contains(&value))
    {
        anyhow::bail!("unsupported SQLite URL mode or cache");
    }
    let options: SqliteConnectOptions = url.parse()?;
    let filename = options.get_filename();
    // SQLx decodes the filename before handing it to SQLite with URI support.
    // Reject nested file URIs before accepting a memory URL: they can override
    // the outer mode. The literal :memory: is the sole exception because SQLx
    // itself maps it to a generated file:sqlx-in-memory-* name.
    if database != ":memory:"
        && filename
            .to_str()
            .is_none_or(|name| name.starts_with("file:"))
    {
        anyhow::bail!("unsupported SQLite database path");
    }
    if database == ":memory:"
        || filename == Path::new(":memory:")
        || mode.as_deref() == Some("memory")
    {
        if allow_memory {
            return Ok(None);
        }
        anyhow::bail!("source history requires an existing file-backed SQLite database");
    }
    if filename.as_os_str().is_empty() {
        anyhow::bail!("unsupported SQLite database path");
    }
    let create = allow_creation && mode.as_deref() == Some("rwc");
    let canonical = claim_file(filename, create)?;
    Ok(Some(options.filename(canonical).create_if_missing(false)))
}

#[cfg(unix)]
fn claim_file(path: &Path, create: bool) -> anyhow::Result<PathBuf> {
    let parent = path
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let parent = canonical_path(parent)?;
    let name = path
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("SQLite database has no file name"))?;
    let candidate = parent.join(name);
    // On Unix, closing any extra descriptor for a SQLite file can release
    // that process's fcntl locks. Refuse a duplicate by metadata before ever
    // opening another descriptor, and serialize competing same-process claims.
    let mut owners = OWNERS
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .map_err(|_| anyhow::anyhow!("Host database lease registry poisoned"))?;
    if owners.len() >= MAX_PROCESS_DATABASES {
        anyhow::bail!("too many Host database leases in this process");
    }
    match fs::symlink_metadata(&candidate) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            anyhow::bail!("SQLite database is not a regular file")
        }
        Ok(metadata) => {
            if owned_identity(&metadata, &owners)? {
                anyhow::bail!(
                    "Host database was already claimed in this process; restart required"
                );
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && create => {}
        Err(error) => return Err(error.into()),
    }
    // Validate the owner-controlled lock directory before creating a new DB.
    let root = parent.join(LOCK_DIRECTORY);
    let directory = match PrivateDirectory::create_new(&root) {
        Ok(directory) => directory,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            PrivateDirectory::open(&root)?
        }
        Err(error) => return Err(error.into()),
    };
    let database = match File::open(&candidate) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && create => {
            match OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .open(&candidate)
            {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let metadata = fs::symlink_metadata(&candidate)?;
                    if !metadata.file_type().is_file() || owned_identity(&metadata, &owners)? {
                        anyhow::bail!("SQLite database is unsupported or already claimed");
                    }
                    File::open(&candidate)?
                }
                Err(error) => return Err(error.into()),
            }
        }
        Err(error) => return Err(error.into()),
    };
    let canonical = canonical_path(&candidate)?;
    let identity = verify_database(&database, &canonical)?;
    if owners.contains_key(&identity) {
        anyhow::bail!("Host database was already claimed in this process; restart required");
    }
    let lease = HeldPrivateWriterLease::exclusive(Arc::new(directory), &identity)
        .map_err(|error| anyhow::anyhow!("Host database lease unavailable: {error}"))?;
    if verify_database(&database, &canonical)? != identity {
        anyhow::bail!("SQLite database identity changed during lease acquisition");
    }
    lease.validate()?;
    owners.insert(
        identity,
        ProcessLease {
            database,
            _lease: lease,
        },
    );
    Ok(canonical)
}

#[cfg(unix)]
fn canonical_path(path: &Path) -> anyhow::Result<PathBuf> {
    Ok(fs::canonicalize(path)?)
}

#[cfg(unix)]
fn owned_identity(
    metadata: &fs::Metadata,
    owners: &BTreeMap<String, ProcessLease>,
) -> anyhow::Result<bool> {
    for owner in owners.values() {
        let held = owner.database.metadata()?;
        if held.dev() == metadata.dev() && held.ino() == metadata.ino() {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(not(unix))]
fn claim_file(_path: &Path, _create: bool) -> anyhow::Result<PathBuf> {
    anyhow::bail!("Host database leases are unsupported on this platform")
}

#[cfg(unix)]
fn verify_database(file: &File, path: &Path) -> anyhow::Result<String> {
    let held = file.metadata()?;
    let named = fs::symlink_metadata(path)?;
    if !held.is_file()
        || !named.file_type().is_file()
        || held.nlink() != 1
        || named.nlink() != 1
        || held.dev() != named.dev()
        || held.ino() != named.ino()
    {
        anyhow::bail!("SQLite database identity is unsupported or changed");
    }
    Ok(format!("host-sqlite:{}:{}", held.dev(), held.ino()))
}

#[cfg(test)]
mod tests {
    use super::claim_url;

    #[test]
    fn memory_is_allowed_only_when_requested_and_unsafe_urls_fail_closed() {
        for url in [
            "sqlite::memory:",
            "sqlite://:memory:",
            "sqlite://?mode=memory",
            "sqlite::memory:?mode=memory",
            "sqlite:%3Amemory%3A?mode=memory",
        ] {
            assert!(claim_url(url, true, true).unwrap().is_none());
            assert!(claim_url(url, false, false).is_err());
        }
        for url in [
            "sqlite:file:alternate.db?mode=rwc",
            "sqlite:%66ile:%2Ftmp%2Falternate.db%3Fmode%3Drw?mode=memory",
            "sqlite:alternate.db?vfs=custom",
            "sqlite:alternate.db?mode=rwc&mode=memory",
            "sqlite:alternate.db?immutable=1",
        ] {
            assert!(claim_url(url, true, true).is_err(), "accepted {url}");
        }
    }

    #[test]
    fn missing_database_is_not_created_for_offline_initialization() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("missing.db");
        let url = format!("sqlite:{}?mode=rwc", database.display());
        assert!(claim_url(&url, false, false).is_err());
        assert!(!database.exists());
    }

    #[cfg(unix)]
    #[test]
    fn repeated_and_aliased_claims_are_refused_for_the_process_lifetime() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("host.db");
        let url = format!("sqlite:{}?mode=rwc", database.display());
        assert!(claim_url(&url, false, true).unwrap().is_some());
        let again = claim_url(&url, false, true).unwrap_err().to_string();
        assert!(again.contains("already claimed"), "{again}");

        let hardlink = directory.path().join("hardlink.db");
        std::fs::hard_link(&database, &hardlink).unwrap();
        let alias = format!("sqlite:{}", hardlink.display());
        let error = claim_url(&alias, false, false).unwrap_err().to_string();
        assert!(error.contains("already claimed"), "{error}");
        std::fs::remove_file(hardlink).unwrap();

        let symlink = directory.path().join("symlink.db");
        std::os::unix::fs::symlink(&database, &symlink).unwrap();
        let alias = format!("sqlite:{}", symlink.display());
        assert!(claim_url(&alias, false, false).is_err());
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "requires Lean-generated correspondence vectors"]
    fn lean_vectors_match_file_lease_claims() {
        let path = std::env::var("OPENSESAME_SOURCE_HISTORY_VECTORS").unwrap();
        let vectors = std::fs::read_to_string(path).unwrap();
        let mut seen = std::collections::BTreeSet::new();
        for line in vectors.lines().filter(|line| line.starts_with("file\t")) {
            let fields: Vec<_> = line.split('\t').collect();
            assert_eq!(fields.len(), 3);
            assert!(seen.insert(fields[1].to_owned()));
            let directory = tempfile::tempdir().unwrap();
            let url = format!(
                "sqlite:{}?mode=rwc",
                directory.path().join("host.db").display()
            );
            match fields[1] {
                "1" => assert!(claim_url(&url, false, true).is_ok()),
                "0" => {}
                _ => panic!("invalid occupied bit"),
            }
            let acquired = claim_url(&url, false, true).is_ok();
            assert_eq!(acquired, fields[2] == "1");
            assert!(matches!(fields[2], "0" | "1"));
        }
        assert_eq!(seen.len(), 2, "model must emit both lease cases");
    }
}
