//! Where validated generations go. The production sink is
//! `opensesame_transport_security::TransportGenerations` (see
//! [`crate::sink::transport`]); tests use [`RecordingSink`].

use opensesame_domain::{TransportError, TrustProfileRef};
use opensesame_time::{DateTime, Utc};
use std::collections::BTreeSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::snapshot::SvidGeneration;

/// An owned storage operation that can run without holding a source lock.
pub type HistoryWrite = Pin<Box<dyn Future<Output = Result<(), TransportError>> + Send>>;

/// A write-ahead operation and whether preparing it withdrew a generation
/// that contained a local bundle under an incoming source-owned name.
pub struct PreparedHistory {
    pub write: HistoryWrite,
    pub withdrew_local_conflict: bool,
}

/// Preparation distinguishes a rejected candidate from an unavailable
/// history store or lost source ownership, which require a fresh stream.
#[derive(Debug)]
pub enum PreparationError {
    Candidate(TransportError),
    Lease(TransportError),
    History(TransportError),
}

/// A trusted write-ahead reservation store. Implementations must preserve all
/// previously reserved names and acknowledge only after the union is durable.
/// The source drops superseded futures: a started write that outlives its
/// future must keep the trust-owner guard until it is known quiescent, and an
/// unknown outcome must fence successor managers. Implementations must bound
/// outstanding detached work and refuse saturation synchronously. They must
/// never activate a generation on behalf of a dropped future.
pub trait GenerationHistory: Send + Sync + 'static {
    /// Reserve bounded write capacity before starting an asynchronous union.
    ///
    /// # Errors
    /// The store cannot accept another write safely.
    fn reserve(&self, names: BTreeSet<TrustProfileRef>) -> Result<HistoryWrite, TransportError>;
}

/// A consumer of generations that can grant one exclusive source lease.
pub trait GenerationSink: Send + Sync + 'static {
    /// Atomically claim the sink and quarantine any prior material. No source
    /// is started if the claim fails.
    ///
    /// # Errors
    /// Another owner is active or the sink cannot be claimed safely.
    fn claim(&self) -> Result<Box<dyn GenerationLease>, TransportError>;
}

/// An exclusive source session. Implementations must fence each operation to
/// this owner and its current source epoch, including retirement.
pub trait GenerationLease: Send + 'static {
    /// Validate a candidate and prepare its write-ahead reservation. The
    /// returned future must be awaited without holding the lease lock.
    ///
    /// # Errors
    /// The owner is stale or the candidate cannot be accepted.
    fn prepare(&mut self, generation: &SvidGeneration)
        -> Result<PreparedHistory, PreparationError>;

    /// Activate a validated candidate and advance the source epoch.
    ///
    /// # Errors
    /// The owner is stale or the candidate is refused.
    fn activate(
        &mut self,
        generation: &SvidGeneration,
        wait_deadline: DateTime<Utc>,
        wait_monotonic: Instant,
    ) -> Result<u64, TransportError>;

    /// Shorten the current epoch's use-time bound.
    ///
    /// # Errors
    /// The owner or epoch is stale.
    fn tighten(
        &mut self,
        deadline: DateTime<Utc>,
        monotonic_deadline: Instant,
    ) -> Result<(), TransportError>;

    /// Withdraw the current epoch without affecting a successor.
    ///
    /// # Errors
    /// The owner or epoch is stale.
    fn withdraw(&mut self, reason: TransportError) -> Result<(), TransportError>;

    /// Retire the owner and leave the sink quarantined.
    ///
    /// # Errors
    /// The owner or epoch is stale.
    fn retire(&mut self) -> Result<(), TransportError>;
}

/// The handle and the task share a serialized retirement capability. Retiring
/// from either side prevents a task that wakes later from publishing again.
#[derive(Clone)]
pub(crate) struct SharedLease(Arc<Mutex<Box<dyn GenerationLease>>>);

impl SharedLease {
    pub(crate) fn new(lease: Box<dyn GenerationLease>) -> Self {
        Self(Arc::new(Mutex::new(lease)))
    }

    fn with<T>(
        &self,
        f: impl FnOnce(&mut dyn GenerationLease) -> Result<T, TransportError>,
    ) -> Result<T, TransportError> {
        let mut lease = self
            .0
            .lock()
            .map_err(|_| TransportError::SourceUnsupported)?;
        f(lease.as_mut())
    }

    pub(crate) fn activate(
        &self,
        generation: &SvidGeneration,
        wait_deadline: DateTime<Utc>,
        wait_monotonic: Instant,
    ) -> Result<u64, TransportError> {
        self.with(|lease| lease.activate(generation, wait_deadline, wait_monotonic))
    }

    pub(crate) fn prepare(
        &self,
        generation: &SvidGeneration,
    ) -> Result<PreparedHistory, PreparationError> {
        let mut lease = self
            .0
            .lock()
            .map_err(|_| PreparationError::Lease(TransportError::SourceUnsupported))?;
        lease.prepare(generation)
    }

    pub(crate) fn tighten(
        &self,
        deadline: DateTime<Utc>,
        monotonic_deadline: Instant,
    ) -> Result<(), TransportError> {
        self.with(|lease| lease.tighten(deadline, monotonic_deadline))
    }

    pub(crate) fn withdraw(&self, reason: TransportError) -> Result<(), TransportError> {
        self.with(|lease| lease.withdraw(reason))
    }

    pub(crate) fn retire(&self) {
        // A panic while a lease operation holds this lock must still quarantine
        // the manager. The concrete owner/epoch check prevents stale retirement.
        let mut lease = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let _ = lease.retire();
    }
}

impl std::fmt::Debug for SharedLease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SharedLease").finish_non_exhaustive()
    }
}

/// A lease held by the source task. Drop retires even on cancellation or panic.
pub(crate) struct ClaimedSink(pub SharedLease);

impl Drop for ClaimedSink {
    fn drop(&mut self) {
        self.0.retire();
    }
}

/// A sink that records calls. Test-only.
#[cfg(feature = "fake-workload-api")]
#[path = "sink/recording.rs"]
pub mod recording;

pub mod transport;

pub use transport::TransportGenerationsSink;
