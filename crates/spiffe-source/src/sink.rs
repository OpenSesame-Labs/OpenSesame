//! Where validated generations go. The production sink is
//! `opensesame_transport_security::TransportGenerations` (see
//! [`crate::sink::transport`]); tests use [`RecordingSink`].

use opensesame_time::{DateTime, Utc};
use opensesame_domain::TransportError;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::snapshot::SvidGeneration;

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
    /// Activate a validated candidate and advance the source epoch.
    ///
    /// # Errors
    /// The owner is stale or the candidate is refused.
    fn activate(&mut self, generation: &SvidGeneration) -> Result<u64, TransportError>;

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

    pub(crate) fn activate(&self, generation: &SvidGeneration) -> Result<u64, TransportError> {
        self.with(|lease| lease.activate(generation))
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
