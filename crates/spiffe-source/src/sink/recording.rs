//! A source-owned recording sink for the synthetic Workload API tests.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use opensesame_domain::TransportError;
use opensesame_time::{DateTime, Utc};

use super::{GenerationLease, GenerationSink, PreparationError, PreparedHistory};
use crate::snapshot::SvidGeneration;

/// One observed sink event (no key material).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SinkEvent {
    /// A generation was activated with this number, ID and thumbprint.
    Activated {
        number: u64,
        spiffe_id: String,
        thumbprint: String,
        trust_domains: Vec<String>,
    },
    /// The current generation was withdrawn.
    Withdrawn(TransportError),
}

#[derive(Debug, Default)]
struct RecordingState {
    events: Mutex<Vec<SinkEvent>>,
    next: Mutex<u64>,
    reject: Mutex<Option<TransportError>>,
    claimed: Mutex<bool>,
}

/// Records activations and withdrawals; optionally rejects activations.
#[derive(Debug, Default)]
pub struct RecordingSink {
    state: Arc<RecordingState>,
}

impl RecordingSink {
    /// A shared, empty sink.
    #[must_use]
    pub fn shared() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Snapshot of everything seen so far.
    #[must_use]
    pub fn events(&self) -> Vec<SinkEvent> {
        self.state
            .events
            .lock()
            .map(|e| e.clone())
            .unwrap_or_default()
    }

    /// Make every following activation fail with `reason` (None: accept).
    pub fn reject_activations(&self, reason: Option<TransportError>) {
        if let Ok(mut reject) = self.state.reject.lock() {
            *reject = reason;
        }
    }

    /// The last event, if any.
    #[must_use]
    pub fn last(&self) -> Option<SinkEvent> {
        self.events().last().cloned()
    }
}

struct RecordingLease {
    state: Arc<RecordingState>,
    active: bool,
    retired: bool,
    wall_deadline: Option<DateTime<Utc>>,
    monotonic_deadline: Option<Instant>,
}

impl GenerationSink for RecordingSink {
    fn claim(&self) -> Result<Box<dyn GenerationLease>, TransportError> {
        let mut claimed = self
            .state
            .claimed
            .lock()
            .map_err(|_| TransportError::SourceUnsupported)?;
        if *claimed {
            return Err(TransportError::GenerationStale);
        }
        *claimed = true;
        Ok(Box::new(RecordingLease {
            state: Arc::clone(&self.state),
            active: false,
            retired: false,
            wall_deadline: None,
            monotonic_deadline: None,
        }))
    }
}

impl GenerationLease for RecordingLease {
    fn prepare(
        &mut self,
        _generation: &SvidGeneration,
    ) -> Result<PreparedHistory, PreparationError> {
        if self.retired {
            return Err(PreparationError::Lease(TransportError::GenerationStale));
        }
        Ok(PreparedHistory {
            write: Box::pin(async { Ok(()) }),
            withdrew_local_conflict: false,
        })
    }

    fn activate(
        &mut self,
        generation: &SvidGeneration,
        _wait_deadline: DateTime<Utc>,
        _wait_monotonic: Instant,
    ) -> Result<u64, TransportError> {
        if self.retired {
            return Err(TransportError::GenerationStale);
        }
        if let Some(reason) = self.state.reject.lock().ok().and_then(|r| r.clone()) {
            return Err(reason);
        }
        let mut next = self
            .state
            .next
            .lock()
            .map_err(|_| TransportError::SourceUnsupported)?;
        *next += 1;
        let number = *next;
        let mut events = self
            .state
            .events
            .lock()
            .map_err(|_| TransportError::SourceUnsupported)?;
        events.push(SinkEvent::Activated {
            number,
            spiffe_id: generation.spiffe_id.clone(),
            thumbprint: generation.leaf_thumbprint_sha256.clone(),
            trust_domains: generation
                .bundles
                .trust_domains()
                .map(str::to_owned)
                .collect(),
        });
        self.active = true;
        Ok(number)
    }

    fn tighten(
        &mut self,
        deadline: DateTime<Utc>,
        monotonic_deadline: Instant,
    ) -> Result<(), TransportError> {
        if self.retired {
            return Err(TransportError::GenerationStale);
        }
        let wall = self.wall_deadline.map_or(deadline, |cur| cur.min(deadline));
        let mono = self
            .monotonic_deadline
            .map_or(monotonic_deadline, |cur| cur.min(monotonic_deadline));
        if self.wall_deadline == Some(wall) && self.monotonic_deadline == Some(mono) {
            return Ok(());
        }
        self.wall_deadline = Some(wall);
        self.monotonic_deadline = Some(mono);
        Ok(())
    }

    fn withdraw(&mut self, reason: TransportError) -> Result<(), TransportError> {
        if self.active {
            self.state
                .events
                .lock()
                .map_err(|_| TransportError::SourceUnsupported)?
                .push(SinkEvent::Withdrawn(reason));
            self.active = false;
        }
        Ok(())
    }

    fn retire(&mut self) -> Result<(), TransportError> {
        if !self.retired {
            self.withdraw(TransportError::SourceUnsupported)?;
            *self
                .state
                .claimed
                .lock()
                .map_err(|_| TransportError::SourceUnsupported)? = false;
            self.retired = true;
        }
        Ok(())
    }
}
