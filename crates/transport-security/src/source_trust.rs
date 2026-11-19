//! Source trust provenance for generation-bound preparation.
use std::collections::{BTreeMap, BTreeSet};

use opensesame_domain::transport::{TransportError, TrustProfileRef};

use super::TransportGenerations;
use crate::trust::TrustBundle;

/// Authoritative source bundles and names reserved by earlier snapshots.
#[derive(Clone, Debug)]
pub struct SourceTrust {
    pub bundles: BTreeMap<TrustProfileRef, TrustBundle>,
    pub reserved: BTreeSet<TrustProfileRef>,
}

impl TransportGenerations {
    /// Read the observed-expiry latch for model correspondence tests.
    ///
    /// # Errors
    /// The manager's activation lock is poisoned.
    #[cfg(any(test, feature = "testkit"))]
    pub fn source_expired_latched(&self) -> Result<Option<bool>, TransportError> {
        let serial = self
            .activation
            .lock()
            .map_err(|_| TransportError::SourceUnsupported)?;
        Ok(serial.fence.as_ref().map(|fence| fence.expired))
    }

    /// Return source provenance for preparation against one current generation.
    /// The eventual activation must still compare-and-set that generation.
    ///
    /// # Errors
    /// The generation changed or the manager lock is poisoned.
    pub fn source_trust(&self, expected: u64) -> Result<Option<SourceTrust>, TransportError> {
        let serial = self
            .activation
            .lock()
            .map_err(|_| TransportError::SourceUnsupported)?;
        if self.current.load().number != expected {
            return Err(TransportError::GenerationStale);
        }
        Ok(serial.fence.as_ref().map(|fence| SourceTrust {
            bundles: fence.trust.clone(),
            reserved: serial.source_profiles.clone(),
        }))
    }
}
