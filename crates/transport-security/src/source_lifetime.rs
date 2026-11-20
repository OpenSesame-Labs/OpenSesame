//! A source-owned deadline, checked together with its transport generation.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::Instant;

use opensesame_time::{DateTime, Utc};
use opensesame_domain::transport::{TransportError, TrustProfileRef};

use super::{Generation, GenerationCandidate, TransportGenerations};
use crate::trust::TrustBundle;

#[path = "source_history_activation.rs"]
mod source_history_activation;
#[path = "source_trust.rs"]
mod source_trust;
pub use source_trust::{SourceTrust, MAX_SOURCE_HISTORY_PROFILES};

#[derive(Debug)]
struct OwnerKey {
    manager: Weak<TransportGenerations>,
    retired: AtomicBool,
    initial_generation: u64,
}

/// An opaque capability for one source and one generation manager.
#[derive(Clone, Debug)]
pub struct SourceOwner(Arc<OwnerKey>);

impl SourceOwner {
    fn belongs_to(&self, manager: &TransportGenerations) -> bool {
        std::ptr::eq(self.0.manager.as_ptr(), manager) && !self.0.retired.load(Ordering::SeqCst)
    }

    fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

#[derive(Debug)]
struct Fence {
    owner: SourceOwner,
    /// Last accepted transport number; ordinary trust updates preserve this epoch.
    epoch: u64,
    /// None means the source has claimed the slot but has not activated.
    deadline: Option<DateTime<Utc>>,
    monotonic_deadline: Option<Instant>,
    expired: bool,
    trust: BTreeMap<TrustProfileRef, TrustBundle>,
    own_trust: Option<TrustProfileRef>,
}

#[derive(Debug, Default)]
pub(super) struct SourceState {
    fence: Option<Fence>,
    /// Once a source claims this manager, only an explicitly claimed source
    /// can reactivate it, including after that source retires.
    managed: bool,
    source_profiles: BTreeSet<TrustProfileRef>,
    pending: Option<source_history_activation::Pending>,
}

impl SourceState {
    fn check_deadline(
        &mut self,
        now: DateTime<Utc>,
        monotonic: Instant,
    ) -> Result<(), TransportError> {
        if let Some(fence) = &mut self.fence {
            let Some(deadline) = fence.deadline else {
                return Err(TransportError::IdentityMissing);
            };
            fence.expired |=
                now >= deadline || fence.monotonic_deadline.is_none_or(|d| monotonic >= d);
            if fence.expired {
                return Err(TransportError::EvidenceExpired);
            }
        } else if self.managed {
            return Err(TransportError::SourceUnsupported);
        }
        Ok(())
    }

    pub(super) fn allow_ordinary_activation(
        &mut self,
        current: &Generation,
        candidate: &GenerationCandidate,
        now: DateTime<Utc>,
    ) -> Result<(), TransportError> {
        if !self.managed {
            return self.allow_unmanaged_history(candidate);
        }
        if current.withdrawn.is_some() {
            return Err(TransportError::GenerationStale);
        }
        self.check_deadline(now, Instant::now())?;
        let same_identity = match (&current.identity, &candidate.identity) {
            (Some(old), Some(new)) => Arc::ptr_eq(old, new),
            _ => false,
        };
        let fence = self
            .fence
            .as_ref()
            .ok_or(TransportError::SourceUnsupported)?;
        let trust_unchanged = self.source_profiles.iter().all(|profile| {
            match (fence.trust.get(profile), candidate.peer_trust.get(profile)) {
                (None, None) => true,
                (Some(source), Some(proposed)) => {
                    source.profile() == profile
                        && proposed.profile() == profile
                        && source.generation() == proposed.generation()
                        && source.kind() == proposed.kind()
                        && source.spiffe_trust_domain() == proposed.spiffe_trust_domain()
                        && source.anchors() == proposed.anchors()
                        && source.crls() == proposed.crls()
                }
                _ => false,
            }
        });
        if current.withdrawn.is_some() || !same_identity || !trust_unchanged {
            return Err(TransportError::GenerationStale);
        }
        // own_trust is a validation input rather than stored generation state;
        // ordinary callers need not know it, but cannot bypass it.
        let mut protected = candidate.clone();
        protected.own_trust.clone_from(&fence.own_trust);
        protected.validate(now)?;
        Ok(())
    }

    pub(super) fn revoke_source(&mut self) {
        if let Some(fence) = self.fence.take() {
            fence.owner.0.retired.store(true, Ordering::SeqCst);
        }
    }

    fn matching(&self, owner: &SourceOwner, epoch: u64) -> bool {
        self.fence
            .as_ref()
            .is_some_and(|fence| fence.owner.same(owner) && fence.epoch == epoch)
    }
}

impl TransportGenerations {
    /// Create an owner capability bound to this manager and its current
    /// generation. It must be claimed before a source can publish material.
    #[must_use]
    pub fn source_owner(self: &Arc<Self>) -> SourceOwner {
        let _serial = self
            .activation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        SourceOwner(Arc::new(OwnerKey {
            manager: Arc::downgrade(self),
            retired: AtomicBool::new(false),
            initial_generation: self.current.load().number,
        }))
    }

    /// Claim exclusive source ownership and quarantine the previous material
    /// before the source starts. No ordinary activation may undo quarantine.
    ///
    /// # Errors
    /// The owner is stale or another source already owns the manager.
    pub fn claim_source(&self, owner: &SourceOwner) -> Result<u64, TransportError> {
        let mut serial = self
            .activation
            .lock()
            .map_err(|_| TransportError::SourceUnsupported)?;
        if !owner.belongs_to(self)
            || serial.fence.is_some()
            || self.current.load().number != owner.0.initial_generation
        {
            return Err(TransportError::GenerationStale);
        }
        self.withdraw_locked(TransportError::SourceUnsupported);
        let epoch = self.current.load().number;
        serial.managed = true;
        serial.fence = Some(Fence {
            owner: owner.clone(),
            epoch,
            deadline: None,
            monotonic_deadline: None,
            expired: false,
            trust: BTreeMap::new(),
            own_trust: None,
        });
        Ok(epoch)
    }

    /// Publish a validated source snapshot and its certificate deadline as
    /// one activation. The returned number is the source epoch, which remains
    /// stable through ordinary same-identity trust changes.
    ///
    /// # Errors
    /// The owner is stale, another source owns the slot, or validation fails.
    pub fn activate_from_source(
        &self,
        owner: &SourceOwner,
        expected_epoch: u64,
        candidate: GenerationCandidate,
    ) -> Result<u64, TransportError> {
        let mut serial = self
            .activation
            .lock()
            .map_err(|_| TransportError::SourceUnsupported)?;
        if !owner.belongs_to(self) || !serial.matching(owner, expected_epoch) {
            return Err(TransportError::GenerationStale);
        }
        if candidate
            .peer_trust
            .iter()
            .any(|(key, bundle)| key != bundle.profile())
        {
            return Err(TransportError::GenerationStale);
        }
        let deadline = candidate
            .identity
            .as_ref()
            .ok_or(TransportError::IdentityMissing)?
            .not_after();
        let monotonic = Instant::now();
        let now = Utc::now();
        if now >= deadline {
            return Err(TransportError::EvidenceExpired);
        }
        let monotonic_deadline = monotonic_bound(deadline, now, monotonic)?;
        let trust = candidate.peer_trust.clone();
        let own_trust = candidate.own_trust.clone();
        let epoch = self.swap_in(candidate)?;
        serial.source_profiles.extend(trust.keys().cloned());
        serial.fence = Some(Fence {
            owner: owner.clone(),
            epoch,
            deadline: Some(deadline),
            monotonic_deadline: Some(monotonic_deadline),
            expired: false,
            trust,
            own_trust,
        });
        Ok(epoch)
    }

    /// Shorten the current source epoch's deadline. An older owner or epoch
    /// cannot affect a subsequently accepted snapshot.
    ///
    /// # Errors
    /// The owner or source epoch is no longer current.
    pub fn tighten_source_deadline(
        &self,
        owner: &SourceOwner,
        epoch: u64,
        deadline: DateTime<Utc>,
    ) -> Result<(), TransportError> {
        let monotonic = Instant::now();
        let bound = monotonic_bound(deadline, Utc::now(), monotonic)?;
        self.tighten_source_deadline_bounded(owner, epoch, deadline, bound)
    }

    /// Shorten both wall and monotonic bounds, using an independently sampled
    /// monotonic deadline from the event that caused the tightening.
    ///
    /// # Errors
    /// The owner or source epoch is no longer current.
    pub fn tighten_source_deadline_bounded(
        &self,
        owner: &SourceOwner,
        epoch: u64,
        deadline: DateTime<Utc>,
        monotonic_deadline: Instant,
    ) -> Result<(), TransportError> {
        let mut serial = self
            .activation
            .lock()
            .map_err(|_| TransportError::SourceUnsupported)?;
        if !owner.belongs_to(self) || !serial.matching(owner, epoch) {
            return Err(TransportError::GenerationStale);
        }
        serial.pending = None;
        let fence = serial
            .fence
            .as_mut()
            .ok_or(TransportError::GenerationStale)?;
        let current = fence.deadline.ok_or(TransportError::IdentityMissing)?;
        fence.deadline = Some(current.min(deadline));
        fence.monotonic_deadline = Some(
            fence
                .monotonic_deadline
                .ok_or(TransportError::IdentityMissing)?
                .min(monotonic_deadline),
        );
        Ok(())
    }

    /// Withdraw only the named source epoch. A later activation or owner is
    /// never withdrawn by a delayed event from the previous one.
    ///
    /// # Errors
    /// The owner or source epoch is no longer current.
    pub fn withdraw_from_source(
        &self,
        owner: &SourceOwner,
        epoch: u64,
        reason: TransportError,
    ) -> Result<(), TransportError> {
        let serial = self
            .activation
            .lock()
            .map_err(|_| TransportError::SourceUnsupported)?;
        if !owner.belongs_to(self) || !serial.matching(owner, epoch) {
            return Err(TransportError::GenerationStale);
        }
        if self.current.load().withdrawn.as_ref() != Some(&reason) {
            self.withdraw_locked(reason);
        }
        Ok(())
    }

    /// Retire this owner after its source stops. The generation is withdrawn
    /// before another owner can claim the slot, and the retired owner can
    /// never claim it again.
    ///
    /// # Errors
    /// The owner or source epoch is no longer current.
    pub fn retire_source(&self, owner: &SourceOwner, epoch: u64) -> Result<(), TransportError> {
        let mut serial = self
            .activation
            .lock()
            .map_err(|_| TransportError::SourceUnsupported)?;
        if !owner.belongs_to(self) || !serial.matching(owner, epoch) {
            return Err(TransportError::GenerationStale);
        }
        self.withdraw_locked(TransportError::SourceUnsupported);
        serial.revoke_source();
        Ok(())
    }

    /// Read the current generation and enforce its source deadline at a use
    /// boundary. An observed expiry is latched until a new source activation.
    ///
    /// # Errors
    /// The generation changed, was withdrawn, or its source bound has elapsed.
    pub fn checked_current(
        &self,
        expected: Option<u64>,
    ) -> Result<Arc<Generation>, TransportError> {
        self.checked_current_with_clock(expected, || (Utc::now(), Instant::now()))
    }

    /// Test an explicit instant against the real source fence.
    ///
    /// # Errors
    /// As [`Self::checked_current`].
    #[cfg(any(test, feature = "testkit"))]
    pub fn checked_current_at(
        &self,
        expected: Option<u64>,
        now: DateTime<Utc>,
    ) -> Result<Arc<Generation>, TransportError> {
        self.checked_current_with_clock(expected, || (now, Instant::now()))
    }

    fn checked_current_with_clock(
        &self,
        expected: Option<u64>,
        clock: impl FnOnce() -> (DateTime<Utc>, Instant),
    ) -> Result<Arc<Generation>, TransportError> {
        let mut serial = self
            .activation
            .lock()
            .map_err(|_| TransportError::SourceUnsupported)?;
        let current = self.current.load_full();
        if let Some(reason) = &current.withdrawn {
            return Err(reason.clone());
        }
        if expected.is_some_and(|number| number != current.number) {
            return Err(TransportError::GenerationStale);
        }
        // Sample time only after acquiring the same lock used by activation.
        // Validation can hold this lock across the deadline.
        let (now, monotonic) = clock();
        serial.check_deadline(now, monotonic)?;
        Ok(current)
    }
}

fn monotonic_bound(
    deadline: DateTime<Utc>,
    now: DateTime<Utc>,
    monotonic: Instant,
) -> Result<Instant, TransportError> {
    monotonic
        .checked_add((deadline - now).to_std().unwrap_or_default())
        .ok_or(TransportError::SourceUnsupported)
}

#[cfg(test)]
#[path = "source_lifetime_tests.rs"]
mod tests;
