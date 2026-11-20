//! The SPIFFE Workload API identity source.
//!
//! [`SpiffeSource`] claims the sink, then starts a background loop
//! ([`mod@source_loop`]) that streams snapshots from the Workload API, reduces
//! each to a generation, prepares and persists its trust history, activates
//! or withdraws it, and bounds what survives an outage. The handle and
//! wait/status glue live in [`mod@source_handle`]; SDK-failure
//! classification lives in [`mod@source_policy`]; snapshot preparation and
//! history completion live in `source_history_flow`.

use std::sync::Arc;

use opensesame_domain::TransportError;
use tokio::sync::watch;

use crate::config::SpiffeSourceConfig;
use crate::sink::{ClaimedSink, GenerationSink, SharedLease};
use crate::status::SourceStatus;

#[path = "source_policy.rs"]
mod source_policy;
#[path = "source_loop.rs"]
mod source_loop;
#[path = "source_handle.rs"]
mod source_handle;

pub use source_handle::{SpiffeSourceHandle, WaitError};

/// The source itself.
#[derive(Debug)]
pub struct SpiffeSource;

impl SpiffeSource {
    /// Claim and quarantine the sink, then start streaming from the configured socket.
    ///
    /// # Errors
    /// The sink is already owned or cannot be claimed safely.
    pub fn start(
        config: SpiffeSourceConfig,
        sink: Arc<dyn GenerationSink>,
    ) -> Result<SpiffeSourceHandle, TransportError> {
        let lease = SharedLease::new(sink.claim()?);
        let claimed = ClaimedSink(lease.clone());
        let (status_tx, status_rx) = watch::channel(SourceStatus::initial(config.spiffe_id()));
        let (stop_tx, stop_rx) = watch::channel(false);
        let task = tokio::spawn(source_loop::Loop::new(config, claimed, status_tx, stop_rx).run());
        // The task owns the claimed lease; it does not retain the sink Arc.
        drop(sink);
        Ok(source_handle::SpiffeSourceHandle::new(
            status_rx, stop_tx, task, lease,
        ))
    }
}

#[cfg(test)]
#[path = "source_formal_tests.rs"]
mod formal_tests;
