//! The single door every bridge uses onto the sealed store.
//!
//! Bridges never touch `sealed_store` types directly: they go through
//! [`StoreAccess`], so root resolution, unlocking, locking, and the URL→entry
//! search behave identically no matter which foreign protocol asked.
//!
//! The search predicates ([`host_of`], [`trailer_urls`], [`host_matches`],
//! [`name_matches`]) are deliberately pure and free of I/O — they are the
//! part with branching logic worth testing exhaustively, and they are what
//! two different bridges (browserpass and keepassxc) share.

use std::path::{Path, PathBuf};

use opensesame_sealed_store::{
    resolve_store_dir, totp_code, unlock_store_key, Entry, ItemDataKey, StoreRoot,
};
use zeroize::Zeroize;

use crate::BridgeError;

#[path = "store_identity.rs"]
mod identity;
pub use identity::entry_uuid;
use identity::hex;
#[path = "store_match.rs"]
mod matching;
use matching::entry_matches_host;
pub use matching::{
    host_matches, host_of, name_fallback_admits, name_matches, trailer_urls, trailer_value,
};

/// Env var carrying the sealed-store passphrase for a non-interactive bridge.
///
/// A native-messaging host has no TTY — the browser owns its stdio — so the
/// passphrase must arrive out of band. This mirrors `apps/cli`'s own
/// `OPENSESAME_STORE_PASSWORD` escape hatch and is documented as such: it is
/// a human/device-plane convenience, never an agent affordance.
pub const ENV_STORE_PASSWORD: &str = "OPENSESAME_STORE_PASSWORD";

/// Optional explicit store root for a bridge, overriding the usual
/// `OPENSESAME_STORE_DIR` / `PASSWORD_STORE_DIR` / `~/.password-store` chain.
pub const ENV_BRIDGE_STORE_DIR: &str = "OPENSESAME_BRIDGE_STORE_DIR";

/// Upper bound on entries decrypted to answer one URL query.
///
/// A `url:` trailer match requires opening entries, so an unbounded store
/// would turn one autofill into unbounded work. Past this many entries the
/// search degrades to the (cheap, name-only) heuristic pass.
pub const MAX_SEARCH_ENTRIES: usize = 4096;

/// A store entry that answered a query, with its logical path.
#[derive(Debug, Clone)]
pub struct StoreMatch {
    pub name: String,
    pub entry: Entry,
}

impl StoreMatch {
    /// Best-effort login for the entry: an explicit trailer field, else the
    /// last path segment (the `pass`/gopass convention).
    #[must_use]
    pub fn login(&self) -> String {
        trailer_value(&self.entry.trailer, &["login", "username", "user"])
            .unwrap_or_else(|| self.name.rsplit('/').next().unwrap_or("").to_string())
    }
}

/// Root resolution for bridges.
///
/// TODO(dedupe): `apps/cli/src/store.rs::resolve_root` does the same job with
/// tomb-registry support layered on. Lifting the shared half into
/// `crates/sealed-store` is the right end state (§4.4); it is duplicated
/// minimally here so the two agents building on it do not collide in that
/// crate. Bridges deliberately do **not** consult the tomb registry: a
/// browser-launched host must not silently follow an "active tomb" the human
/// switched in another terminal.
#[must_use]
pub fn resolve_root(explicit: Option<PathBuf>) -> PathBuf {
    if let Some(path) = explicit {
        return path;
    }
    if let Some(dir) = std::env::var_os(ENV_BRIDGE_STORE_DIR).filter(|v| !v.is_empty()) {
        return PathBuf::from(dir);
    }
    resolve_store_dir()
}

/// An opened (and possibly unlocked) sealed store.
pub struct StoreAccess {
    root_path: PathBuf,
    root: StoreRoot,
    key: Option<ItemDataKey>,
    locked: bool,
}

impl StoreAccess {
    /// Open `root_path`, unlocking with `passphrase` when the store carries an
    /// `.opensesame-key`. GPG/age-format stores need no passphrase here (the
    /// agent behind `gpg`/`age` supplies it), so `passphrase` may be `None`.
    ///
    /// # Errors
    ///
    /// Returns an error when the store cannot be opened or its key cannot be unlocked.
    pub fn open(root_path: &Path, passphrase: Option<&[u8]>) -> Result<Self, BridgeError> {
        let root = StoreRoot::open(root_path)?;
        Self::open_root(root_path, root, passphrase)
    }

    #[cfg(any(test, feature = "testkit"))]
    #[doc(hidden)]
    pub fn open_with_test_witness_root(
        root_path: &Path,
        witness_root: &Path,
        passphrase: Option<&[u8]>,
    ) -> Result<Self, BridgeError> {
        let root = StoreRoot::open_with_test_witness_root(root_path, witness_root)?;
        Self::open_root(root_path, root, passphrase)
    }

    fn open_root(
        root_path: &Path,
        root: StoreRoot,
        passphrase: Option<&[u8]>,
    ) -> Result<Self, BridgeError> {
        let keyed = root_path.join(".opensesame-key").exists();
        let key = if keyed {
            let passphrase = passphrase.ok_or(BridgeError::Unconfigured(ENV_STORE_PASSWORD))?;
            Some(unlock_store_key(root_path, passphrase)?)
        } else {
            // Foreign formats use their own credentials. Missing native
            // credentials must never be replaced with a usable key.
            None
        };
        Ok(Self {
            root_path: root_path.to_path_buf(),
            root,
            key,
            locked: false,
        })
    }

    /// Open the store a bridge should use, taking the passphrase from
    /// [`ENV_STORE_PASSWORD`] and clearing it from this process's memory.
    ///
    /// # Errors
    ///
    /// Returns the same errors as [`Self::open`].
    pub fn from_env(explicit: Option<PathBuf>) -> Result<Self, BridgeError> {
        let root_path = resolve_root(explicit);
        let mut password = std::env::var(ENV_STORE_PASSWORD)
            .ok()
            .filter(|p| !p.is_empty());
        let access = Self::open(&root_path, password.as_deref().map(str::as_bytes));
        if let Some(p) = password.as_mut() {
            p.zeroize();
        }
        access
    }

    #[must_use]
    pub fn root_path(&self) -> &Path {
        &self.root_path
    }

    /// Whether the store has been locked by a client (`lock-database`).
    #[must_use]
    pub fn is_locked(&self) -> bool {
        self.locked
    }

    /// Drop the item key and refuse further reads until the process restarts.
    /// There is deliberately no in-process unlock: re-entering the passphrase
    /// is a human act on a TTY, which a native-messaging host does not have.
    pub fn lock(&mut self) {
        self.key = None;
        self.locked = true;
    }

    fn key(&self) -> Result<Option<&ItemDataKey>, BridgeError> {
        if self.locked {
            return Err(BridgeError::Locked);
        }
        Ok(self.key.as_ref())
    }

    /// Logical entry names under `prefix` (`""` for the whole store).
    ///
    /// # Errors
    ///
    /// Returns an error when the store cannot list the requested prefix.
    pub fn list(&self, prefix: &str) -> Result<Vec<String>, BridgeError> {
        Ok(self.root.ls(prefix)?)
    }

    /// Decrypt one entry by logical name.
    ///
    /// # Errors
    ///
    /// Returns an error when the store is locked or the entry cannot be read.
    pub fn show(&self, name: &str) -> Result<Entry, BridgeError> {
        Ok(self.root.show_with_optional_key(name, self.key()?, None)?)
    }

    /// Insert or overwrite one entry.
    ///
    /// # Errors
    ///
    /// Returns an error when the store is locked or the entry cannot be written.
    pub fn put(&self, name: &str, entry: &Entry) -> Result<(), BridgeError> {
        Ok(self
            .root
            .insert_or_replace_with_optional_key(name, entry, self.key()?)?)
    }

    /// Current TOTP for an entry that carries an `otpauth://` trailer line.
    ///
    /// # Errors
    ///
    /// Returns an error when the entry cannot be read or has no valid TOTP configuration.
    pub fn totp(&self, name: &str, at_unix: u64) -> Result<String, BridgeError> {
        let entry = self.show(name)?;
        let otp = entry
            .otp
            .ok_or_else(|| BridgeError::Store("entry has no otpauth:// trailer".into()))?;
        totp_code(&otp, at_unix).map_err(|e| BridgeError::Store(e.to_string()))
    }

    /// A stable, non-secret identifier for this store, used where a foreign
    /// protocol expects a "database hash".
    ///
    /// It is the SHA-256 of the canonical root path — a public fact about
    /// *which* store is bridged, never a function of any entry's contents.
    #[must_use]
    pub fn database_hash(&self) -> String {
        use sha2::{Digest, Sha256};
        let canonical = std::fs::canonicalize(&self.root_path).unwrap_or(self.root_path.clone());
        let mut hasher = Sha256::new();
        hasher.update(b"opensesame-sealed-store\0");
        hasher.update(canonical.to_string_lossy().as_bytes());
        hex(&hasher.finalize())
    }

    /// Find entries matching `url`.
    ///
    /// Pass 1 opens entries and matches a `url:`/`uri:`/`website:` trailer
    /// line against the query host. Only if that finds nothing does pass 2
    /// fall back to path-name heuristics — an explicit trailer is always a
    /// stronger signal than a filename that happens to look like a domain, so
    /// an entry that carries one is never handed out on its name alone.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid URL, locked store, or failed listing.
    pub fn find_by_url(&self, url: &str) -> Result<Vec<StoreMatch>, BridgeError> {
        // Check the lock up front. Without this a locked store would look
        // like an *empty* one — every per-entry decrypt failing quietly and
        // the caller told "no matches" instead of "locked".
        let _ = self.key()?;
        let host = host_of(url).ok_or_else(|| BridgeError::Protocol("no host in url".into()))?;
        let names = self.list("")?;

        let matches = self.find_trailer_matches(&names, &host);
        if !matches.is_empty() {
            return Ok(matches);
        }

        Ok(self.find_name_matches(&names, &host))
    }

    fn find_trailer_matches(&self, names: &[String], host: &str) -> Vec<StoreMatch> {
        if names.len() > MAX_SEARCH_ENTRIES {
            return Vec::new();
        }
        names
            .iter()
            .filter_map(|name| {
                let entry = self.show(name).ok()?;
                entry_matches_host(&entry, host).then(|| StoreMatch {
                    name: name.clone(),
                    entry,
                })
            })
            .collect()
    }

    fn find_name_matches(&self, names: &[String], host: &str) -> Vec<StoreMatch> {
        names
            .iter()
            .filter(|name| name_matches(name, host))
            .filter_map(|name| {
                let entry = self.show(name).ok()?;
                name_fallback_admits(&entry, host).then(|| StoreMatch {
                    name: name.clone(),
                    entry,
                })
            })
            .collect()
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
