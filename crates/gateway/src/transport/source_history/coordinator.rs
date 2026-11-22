//! Process-local trust-owner lifetime and storage-write quiescence.
//!
//! A manager keeps an exclusive lease while it can serve. Every started
//! history write also keeps that lease until the `SQLite` operation reports an
//! outcome. If its task disappears without an outcome, the process refuses a
//! successor owner rather than guessing whether the write committed. This is
//! not a cross-process lock. Host integration is pending end-to-end validation.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use opensesame_domain::{TransportError, TrustProfileRef};
use opensesame_spiffe_source::sink::{GenerationHistory, HistoryWrite, TransportGenerationsSink};
use opensesame_storage::Db;
use opensesame_transport_security::{GenerationCandidate, TransportGenerations};
use tokio::sync::{Mutex, OwnedMutexGuard, Semaphore};

use super::{initialize, load, union, HistoryError, SourceHistory};

const MAX_PENDING_WRITES: usize = 4;

#[derive(Debug)]
struct Scope {
    owner: Arc<Mutex<()>>,
    poisoned: AtomicBool,
    writes: Arc<Semaphore>,
    #[cfg(test)]
    started: std::sync::atomic::AtomicUsize,
}

impl Default for Scope {
    fn default() -> Self {
        Self {
            owner: Arc::new(Mutex::new(())),
            poisoned: AtomicBool::new(false),
            writes: Arc::new(Semaphore::new(MAX_PENDING_WRITES)),
            #[cfg(test)]
            started: std::sync::atomic::AtomicUsize::new(0),
        }
    }
}

#[derive(Debug)]
struct LeaseState {
    scope: Arc<Scope>,
    // The guard is held through the manager's lifetime and any write task.
    _owner: OwnedMutexGuard<()>,
}

/// Exclusive process-local ownership of the Host trust namespace.
///
/// The non-clone permit is consumed either by explicit initialization or by
/// constructing one seeded manager. Other processes require separate fencing.
#[derive(Debug)]
pub struct HistoryLease(Arc<LeaseState>);

impl HistoryLease {
    fn hold(&self) -> WriteHold {
        WriteHold(Arc::clone(&self.0))
    }

    /// Explicit operator-only initialization. The caller must first stop all
    /// other Hosts and writers and attest a complete history. This consumes the permit;
    /// the detached worker holds the owner until `SQLite` reports a result even
    /// if its caller is canceled. A later manager must claim a fresh permit.
    ///
    /// # Errors
    /// The attestation, existing record, `SQLite` operation or worker fails.
    pub async fn initialize(
        self,
        db: Db,
        document: Vec<u8>,
        attest_complete: bool,
    ) -> Result<SourceHistory, HistoryError> {
        if !attest_complete {
            return Err(HistoryError::NotAttested);
        }
        let worker = tokio::spawn(tracked_write(WriteHold(self.0), async move {
            initialize(&db, &document, true).await
        }));
        worker
            .await
            .map_err(|_| HistoryError::Storage("initialization worker failed".into()))?
    }

    /// Load complete history and create exactly one manager that retains this
    /// permit for its full Arc lifetime. A colliding initial trust bundle or a
    /// missing history refuses construction before the manager is returned.
    ///
    /// # Errors
    /// The record, initial candidate, manager seeding or `SQLite` read fails.
    pub async fn start_manager(
        self,
        db: Db,
        candidate: GenerationCandidate,
    ) -> Result<ManagedHistory, HistoryError> {
        let history = load(&db).await?;
        let initial = candidate
            .into_generation(1, opensesame_time::Utc::now())
            .map_err(HistoryError::Manager)?;
        let guard: Arc<dyn Send + Sync> = self.hold().0;
        let generations = TransportGenerations::new_with_lifetime_guard(initial, guard);
        generations
            .seed_source_history(1, &history.names())
            .map_err(HistoryError::Manager)?;
        let adapter = Arc::new(CoordinatedHistory {
            db,
            hold: self.hold(),
        });
        Ok(ManagedHistory {
            generations,
            adapter,
        })
    }
}

/// One seeded manager and its matching write-ahead adapter. A manager Arc
/// retains the owner even if this wrapper is dropped; source sinks keep the
/// same owner until their writes have completed or poisoned the scope.
pub struct ManagedHistory {
    generations: Arc<TransportGenerations>,
    adapter: Arc<CoordinatedHistory>,
}

impl ManagedHistory {
    #[must_use]
    pub fn generations(&self) -> Arc<TransportGenerations> {
        Arc::clone(&self.generations)
    }

    #[must_use]
    pub fn source_sink(&self) -> TransportGenerationsSink {
        let history: Arc<dyn GenerationHistory> = self.adapter.clone();
        TransportGenerationsSink::with_history(self.generations(), history)
    }
}

#[derive(Clone)]
struct WriteHold(Arc<LeaseState>);

async fn acquire(scope: Arc<Scope>) -> Result<HistoryLease, HistoryError> {
    let owner = Arc::clone(&scope.owner).lock_owned().await;
    if scope.poisoned.load(Ordering::SeqCst) {
        return Err(HistoryError::Poisoned);
    }
    Ok(HistoryLease(Arc::new(LeaseState {
        scope,
        _owner: owner,
    })))
}

/// Claim the one Host trust-owner slot in this process. This intentionally
/// serializes all Host databases within a process rather than attempting to
/// identify equivalent database paths; it does not coordinate other processes.
///
/// # Errors
/// An earlier write was dropped without a determinate outcome in this process.
pub async fn claim_host_history() -> Result<HistoryLease, HistoryError> {
    static HOST: OnceLock<Arc<Scope>> = OnceLock::new();
    acquire(Arc::clone(HOST.get_or_init(|| Arc::new(Scope::default())))).await
}

/// Perform the explicit one-shot operator action without starting the Host
/// or applying database migrations. Existing history is never overwritten.
///
/// # Errors
/// The attestation, owner claim, existing database, or initialization fails.
pub async fn initialize_host_history(
    database_url: &str,
    document: Vec<u8>,
    attest_complete: bool,
) -> Result<SourceHistory, HistoryError> {
    if !attest_complete {
        return Err(HistoryError::NotAttested);
    }
    if document.len() > super::SOURCE_HISTORY_ATTESTATION_LIMIT {
        return Err(HistoryError::Invalid("attestation exceeds size limit"));
    }
    let permit = tokio::time::timeout(std::time::Duration::from_secs(30), claim_host_history())
        .await
        .map_err(|_| HistoryError::OwnerTimeout)??;
    let options = super::file_lock::claim_url(database_url, false, false)
        .map_err(|error| HistoryError::Storage(error.to_string()))?
        .ok_or(HistoryError::Invalid(
            "history requires a file-backed database",
        ))?;
    let db = Db::connect_sqlite_options(options, false)
        .await
        .map_err(|error| HistoryError::Storage(error.to_string()))?;
    permit.initialize(db, document, true).await
}

struct PendingWrite {
    hold: WriteHold,
    finished: bool,
}

impl PendingWrite {
    fn new(hold: WriteHold) -> Self {
        #[cfg(test)]
        hold.0.scope.started.fetch_add(1, Ordering::SeqCst);
        Self {
            hold,
            finished: false,
        }
    }

    fn finish(&mut self) {
        self.finished = true;
    }
}

impl Drop for PendingWrite {
    fn drop(&mut self) {
        if !self.finished {
            // A dropped SQL future can have an unknown commit outcome. Set
            // this before releasing the last lease/owner guard.
            self.hold.0.scope.poisoned.store(true, Ordering::SeqCst);
        }
    }
}

async fn tracked_write<F: std::future::Future>(hold: WriteHold, operation: F) -> F::Output {
    let mut pending = PendingWrite::new(hold);
    let result = operation.await;
    // A returned error is a completed operation: its successor must reload
    // the durable record, regardless of whether the write committed.
    pending.finish();
    result
}

/// `SQLite` write-ahead adapter tied to an owned process-local scope. A canceled
/// caller detaches the worker; its lease remains held until it completes.
struct CoordinatedHistory {
    db: Db,
    hold: WriteHold,
}

impl GenerationHistory for CoordinatedHistory {
    fn reserve(&self, names: BTreeSet<TrustProfileRef>) -> Result<HistoryWrite, TransportError> {
        // Superseded writes keep running until SQLite acknowledges them. Bound
        // that work before spawning; saturation must fail closed immediately.
        let slot = Arc::clone(&self.hold.0.scope.writes)
            .try_acquire_owned()
            .map_err(|_| TransportError::SourceUnsupported)?;
        let db = self.db.clone();
        let hold = self.hold.clone();
        let worker = tokio::spawn(tracked_write(hold, async move {
            let _slot = slot;
            union(&db, &names).await.map(|_| ())
        }));
        Ok(Box::pin(async move {
            worker
                .await
                .map_err(|_| TransportError::SourceUnsupported)?
                .map_err(|error| TransportError::malformed(format!("source history: {error}")))
        }))
    }
}

#[cfg(test)]
#[path = "coordinator_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "integration_tests.rs"]
mod integration_tests;
