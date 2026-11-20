//! Source trust provenance for generation-bound preparation.
use std::collections::{BTreeMap, BTreeSet};

use opensesame_domain::transport::{TransportError, TrustProfileRef};

use super::{GenerationCandidate, SourceOwner, SourceState, TransportGenerations};
use crate::trust::TrustBundle;

/// Bound both durable and provisional source-name reservations.
pub const MAX_SOURCE_HISTORY_PROFILES: usize = 4_096;

/// Authoritative source bundles and names reserved by earlier snapshots.
#[derive(Clone, Debug)]
pub struct SourceTrust {
    pub bundles: BTreeMap<TrustProfileRef, TrustBundle>,
    pub reserved: BTreeSet<TrustProfileRef>,
}

impl SourceState {
    /// A listener that was previously source-owned can be restarted with a
    /// different identity source. Historical source names remain unavailable
    /// to ordinary activation even when there is no current source fence.
    pub(super) fn allow_unmanaged_history(
        &self,
        candidate: &GenerationCandidate,
    ) -> Result<(), TransportError> {
        if self
            .source_profiles
            .iter()
            .any(|name| candidate.peer_trust.contains_key(name))
        {
            Err(TransportError::GenerationStale)
        } else {
            Ok(())
        }
    }
}

impl TransportGenerations {
    /// Verify an owner and source epoch before beginning asynchronous work.
    /// The caller must recheck them in its eventual activation after the wait.
    ///
    /// # Errors
    /// The capability is stale, belongs elsewhere, or the lock is poisoned.
    pub fn check_source_owner(
        &self,
        owner: &SourceOwner,
        epoch: u64,
    ) -> Result<(), TransportError> {
        let serial = self
            .activation
            .lock()
            .map_err(|_| TransportError::SourceUnsupported)?;
        if !owner.belongs_to(self) || !serial.matching(owner, epoch) {
            return Err(TransportError::GenerationStale);
        }
        Ok(())
    }

    /// Seed validated durable source-name history before exposing the manager
    /// or restoring ordinary trust. This also applies when a prior source is
    /// replaced by a PEM or managed identity.
    ///
    /// The caller is responsible for loading a complete record for the
    /// correct trust owner. This method cannot prove storage durability or the
    /// truth of an operator's historical attestation.
    ///
    /// # Errors
    /// An invalid name, a changed generation, an already-owned manager, a
    /// lock failure, or an existing bundle colliding with the history.
    pub fn seed_source_history(
        &self,
        expected: u64,
        profiles: &BTreeSet<TrustProfileRef>,
    ) -> Result<(), TransportError> {
        if profiles.len() > MAX_SOURCE_HISTORY_PROFILES {
            return Err(TransportError::malformed("source history is full"));
        }
        for profile in profiles {
            profile.validate()?;
        }
        let mut serial = self
            .activation
            .lock()
            .map_err(|_| TransportError::SourceUnsupported)?;
        if serial
            .source_profiles
            .len()
            .saturating_add(profiles.difference(&serial.source_profiles).count())
            > MAX_SOURCE_HISTORY_PROFILES
        {
            return Err(TransportError::malformed("source history is full"));
        }
        let current = self.current.load();
        if serial.managed
            || current.number != expected
            || profiles
                .iter()
                .any(|profile| current.peer_trust.contains_key(profile))
        {
            return Err(TransportError::GenerationStale);
        }
        serial.source_profiles.extend(profiles.iter().cloned());
        Ok(())
    }

    /// Conservatively reserve validated candidate names before starting its
    /// asynchronous durable write. If a name is currently served only as
    /// local trust, withdraw that generation before returning. Reservations
    /// survive retirement and handoff within this manager even if the write
    /// fails or is cancelled. The caller still has to persist and recheck the
    /// owner, epoch and deadline before publishing the candidate.
    ///
    /// # Errors
    /// A stale owner/epoch, invalid name, quota overflow, or poisoned lock.
    pub fn reserve_pending_source_names(
        &self,
        owner: &SourceOwner,
        epoch: u64,
        profiles: &BTreeSet<TrustProfileRef>,
    ) -> Result<bool, TransportError> {
        for profile in profiles {
            profile.validate()?;
        }
        let mut serial = self
            .activation
            .lock()
            .map_err(|_| TransportError::SourceUnsupported)?;
        if !owner.belongs_to(self) || !serial.matching(owner, epoch) {
            return Err(TransportError::GenerationStale);
        }
        let added = profiles.difference(&serial.source_profiles).count();
        if serial.source_profiles.len().saturating_add(added) > MAX_SOURCE_HISTORY_PROFILES {
            return Err(TransportError::malformed("source history is full"));
        }
        let current = self.current.load();
        let source = &serial
            .fence
            .as_ref()
            .ok_or(TransportError::GenerationStale)?
            .trust;
        let conflict = current.withdrawn.is_none()
            && profiles.iter().any(|profile| {
                current.peer_trust.contains_key(profile) && !source.contains_key(profile)
            });
        serial.source_profiles.extend(profiles.iter().cloned());
        if conflict {
            self.withdraw_locked(TransportError::TrustUnknown);
        }
        Ok(conflict)
    }

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
        if !serial.managed && serial.source_profiles.is_empty() {
            return Ok(None);
        }
        Ok(Some(SourceTrust {
            bundles: serial
                .fence
                .as_ref()
                .map_or_else(BTreeMap::new, |fence| fence.trust.clone()),
            reserved: serial.source_profiles.clone(),
        }))
    }
}
