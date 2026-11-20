//! Durable source-name reservations for the Host trust owner.
//!
//! A complete operator attestation and continuous, trusted storage are
//! assumptions, not facts the database can establish. The model and its
//! verification status are documented in `spec/formal/source-trust-history`.

use std::collections::BTreeSet;

use opensesame_domain::transport::{TransportError, TrustProfileRef};
use opensesame_storage::Db;
use serde::{Deserialize, Serialize};
use sqlx::SqliteConnection;

pub mod coordinator;
pub(crate) mod file_lock;

/// Stable authority identity, independent of the Workload API socket or SVID.
pub const HOST_TRUST_OWNER: &str = "host-tls";
const KEY: &str = "transport.source_trust_history.host_tls.v1";
const MAX_BYTES: usize = 512 * 1024;
/// Maximum bytes accepted in an explicit initialization document.
pub const SOURCE_HISTORY_ATTESTATION_LIMIT: usize = MAX_BYTES;
const MAX_NAMES: usize = opensesame_transport_security::MAX_SOURCE_HISTORY_PROFILES;
const MAX_ATTESTATION_FIELD: usize = 256;
const CAS_ATTEMPTS: usize = 8;

/// A complete operator-supplied list. A fresh deployment may attest an empty
/// list, but startup must never manufacture one from a missing record.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Attestation {
    owner: String,
    actor: String,
    change_ref: String,
    names: Vec<String>,
}

/// Versioned record whose names can only grow through the union API.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SourceHistory {
    version: u8,
    owner: String,
    complete: bool,
    actor: String,
    change_ref: String,
    revision: u64,
    names: Vec<String>,
}

/// Failure to establish complete, current history is always an error.
#[derive(Debug, thiserror::Error)]
pub enum HistoryError {
    #[error("source history has not been explicitly initialized")]
    Missing,
    #[error("source history already exists")]
    AlreadyInitialized,
    #[error("source history requires an explicit completeness attestation")]
    NotAttested,
    #[error("invalid source history: {0}")]
    Invalid(&'static str),
    #[error("source history compare-and-set remained contended")]
    Contended,
    #[error("source history owner has an unresolved canceled write; restart required")]
    Poisoned,
    #[error("source history owner did not become available before the startup deadline")]
    OwnerTimeout,
    #[error("source history manager: {0}")]
    Manager(TransportError),
    #[error("source history storage: {0}")]
    Storage(String),
}

impl SourceHistory {
    /// Return reserved names for seeding a manager. Every name was validated
    /// while parsing the record; no names are inferred from the current source.
    #[must_use]
    pub fn names(&self) -> BTreeSet<TrustProfileRef> {
        self.names
            .iter()
            .map(|name| TrustProfileRef { name: name.clone() })
            .collect()
    }

    /// A monotonic revision for observing changes to the durable union.
    #[must_use]
    pub const fn revision(&self) -> u64 {
        self.revision
    }
}

/// Explicitly initialize an absent history exactly once. `document` is a
/// bounded JSON attestation; the independent flag must be supplied by the
/// operator invoking the one-shot action. This function must not be called as
/// an automatic fallback from startup or retry logic.
///
/// # Errors
/// Missing attestation, invalid input, an existing row or a failed DB write.
async fn initialize(
    db: &Db,
    document: &[u8],
    attest_complete: bool,
) -> Result<SourceHistory, HistoryError> {
    if !attest_complete {
        return Err(HistoryError::NotAttested);
    }
    if document.len() > MAX_BYTES {
        return Err(HistoryError::Invalid("attestation exceeds size limit"));
    }
    let input: Attestation = serde_json::from_slice(document)
        .map_err(|_| HistoryError::Invalid("malformed attestation"))?;
    let mut record = SourceHistory {
        version: 1,
        owner: input.owner,
        complete: true,
        actor: input.actor,
        change_ref: input.change_ref,
        revision: 1,
        names: input.names,
    };
    record.names.sort_unstable();
    validate(&record)?;
    let json = serialize(&record)?;
    let inserted = checked_cas(db, None, &json).await?;
    if !inserted {
        return Err(HistoryError::AlreadyInitialized);
    }
    Ok(record)
}

/// Read the complete record; an absent, invalid, or oversized row is never
/// interpreted as an empty history.
///
/// # Errors
/// The row is missing, invalid or unreadable.
async fn load(db: &Db) -> Result<SourceHistory, HistoryError> {
    read(db).await.map(|(_, history)| history)
}

/// Atomically union source-owned names into the record. The caller must
/// validate the candidate before this call and recheck ownership, epoch and
/// deadline after it completes and before publishing that candidate.
///
/// # Errors
/// The record, names, storage operation, revision or bounded retries fail.
async fn union(
    db: &Db,
    incoming: &BTreeSet<TrustProfileRef>,
) -> Result<SourceHistory, HistoryError> {
    union_with_hook(db, incoming, || std::future::ready(())).await
}

async fn union_with_hook<F, Fut>(
    db: &Db,
    incoming: &BTreeSet<TrustProfileRef>,
    mut before_cas: F,
) -> Result<SourceHistory, HistoryError>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    for name in incoming {
        name.validate()
            .map_err(|_| HistoryError::Invalid("invalid profile name"))?;
    }
    for _ in 0..CAS_ATTEMPTS {
        let (raw, mut history) = read(db).await?;
        let mut names: BTreeSet<String> = history.names.iter().cloned().collect();
        names.extend(incoming.iter().map(|name| name.name.clone()));
        if names.len() > MAX_NAMES {
            return Err(HistoryError::Invalid("too many profile names"));
        }
        if names.len() != history.names.len() {
            history.revision = history
                .revision
                .checked_add(1)
                .ok_or(HistoryError::Invalid("revision overflow"))?;
            history.names = names.into_iter().collect();
        }
        let json = serialize(&history)?;
        // Even an unchanged union compares the record: a row removed between
        // read and write must not be treated as successfully persisted.
        before_cas().await;
        if checked_cas(db, Some(&raw), &json).await? {
            return Ok(history);
        }
    }
    Err(HistoryError::Contended)
}

async fn read(db: &Db) -> Result<(String, SourceHistory), HistoryError> {
    let mut connection = db
        .pool()
        .acquire()
        .await
        .map_err(|error| HistoryError::Storage(error.to_string()))?;
    let raw = read_on_connection(&mut connection).await?;
    let history: SourceHistory =
        serde_json::from_str(&raw).map_err(|_| HistoryError::Invalid("malformed record"))?;
    validate(&history)?;
    Ok((raw, history))
}

async fn read_on_connection(connection: &mut SqliteConnection) -> Result<String, HistoryError> {
    ensure_durable(connection).await?;
    // Apply the byte limit in SQLite before returning the value to Rust.
    // NULL denotes an existing invalid or oversized value; SQLite itself
    // still has to access the stored value while evaluating the expression.
    sqlx::query_scalar::<_, Option<String>>(
        "SELECT CASE WHEN typeof(value) = 'text' AND length(CAST(value AS BLOB)) <= ? \
         THEN value ELSE NULL END FROM main.host_kv WHERE key = ?",
    )
    .bind(i64::try_from(MAX_BYTES).expect("history limit fits i64"))
    .bind(KEY)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| HistoryError::Storage(error.to_string()))?
    .ok_or(HistoryError::Missing)?
    .ok_or(HistoryError::Invalid(
        "row exceeds size limit or is not text",
    ))
}

async fn ensure_durable(connection: &mut SqliteConnection) -> Result<(), HistoryError> {
    // Synchronous is connection-local. Check both settings on the exact
    // checked-out connection used for the subsequent statement.
    let synchronous: i64 = sqlx::query_scalar("PRAGMA main.synchronous")
        .fetch_one(&mut *connection)
        .await
        .map_err(|error| HistoryError::Storage(error.to_string()))?;
    let journal: String = sqlx::query_scalar("PRAGMA main.journal_mode")
        .fetch_one(&mut *connection)
        .await
        .map_err(|error| HistoryError::Storage(error.to_string()))?;
    if synchronous < 2
        || !["delete", "truncate", "persist", "wal"]
            .iter()
            .any(|mode| journal.eq_ignore_ascii_case(mode))
    {
        return Err(HistoryError::Invalid("SQLite durability settings"));
    }
    Ok(())
}

async fn checked_cas(db: &Db, expected: Option<&str>, value: &str) -> Result<bool, HistoryError> {
    let mut connection = db
        .pool()
        .acquire()
        .await
        .map_err(|error| HistoryError::Storage(error.to_string()))?;
    checked_cas_on_connection(&mut connection, expected, value).await
}

async fn checked_cas_on_connection(
    connection: &mut SqliteConnection,
    expected: Option<&str>,
    value: &str,
) -> Result<bool, HistoryError> {
    ensure_durable(connection).await?;
    let timestamp = opensesame_time::Utc::now().to_rfc3339();
    let result = match expected {
        Some(expected) => {
            sqlx::query(
                "UPDATE main.host_kv SET value = ?, updated_at = ? WHERE key = ? AND value = ?",
            )
            .bind(value)
            .bind(timestamp)
            .bind(KEY)
            .bind(expected)
            .execute(&mut *connection)
            .await
        }
        None => {
            sqlx::query(
                "INSERT INTO main.host_kv (key, value, updated_at) VALUES (?, ?, ?) \
             ON CONFLICT(key) DO NOTHING",
            )
            .bind(KEY)
            .bind(value)
            .bind(timestamp)
            .execute(&mut *connection)
            .await
        }
    }
    .map_err(|error| HistoryError::Storage(error.to_string()))?;
    Ok(result.rows_affected() == 1)
}

fn validate(history: &SourceHistory) -> Result<(), HistoryError> {
    if history.version != 1 || history.owner != HOST_TRUST_OWNER || !history.complete {
        return Err(HistoryError::Invalid("version, owner or completeness"));
    }
    if history.revision == 0 {
        return Err(HistoryError::Invalid("zero revision"));
    }
    for field in [&history.actor, &history.change_ref] {
        if field.trim().is_empty()
            || field.len() > MAX_ATTESTATION_FIELD
            || field.chars().any(char::is_control)
        {
            return Err(HistoryError::Invalid("attestation metadata"));
        }
    }
    if history.names.len() > MAX_NAMES {
        return Err(HistoryError::Invalid("too many profile names"));
    }
    for name in &history.names {
        TrustProfileRef::new(name).map_err(|_| HistoryError::Invalid("invalid profile name"))?;
    }
    if history.names.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err(HistoryError::Invalid("duplicate or unordered names"));
    }
    Ok(())
}

fn serialize(history: &SourceHistory) -> Result<String, HistoryError> {
    validate(history)?;
    let json = serde_json::to_string(history).map_err(|_| HistoryError::Invalid("encoding"))?;
    if json.len() > MAX_BYTES {
        return Err(HistoryError::Invalid("record exceeds size limit"));
    }
    Ok(json)
}

#[cfg(test)]
#[path = "source_history/tests.rs"]
mod tests;
