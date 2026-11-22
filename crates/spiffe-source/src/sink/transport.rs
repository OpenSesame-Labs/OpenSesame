//! The production sink: `opensesame_transport_security::TransportGenerations`.
//!
//! Every Workload API snapshot becomes one [`GenerationCandidate`]: the
//! selected SVID as the identity (`identity_required`), and one
//! [`TrustBundle`] of kind `SpiffeTrustDomain` per trust domain the snapshot
//! carried, each under a trust profile named after its domain. `own_trust`
//! names the SVID's own domain so the manager re-verifies our chain against
//! our issuer before the swap. A withdrawal is
//! [`TransportGenerations::withdraw`], which every listener and client built
//! on the manager observes on its next handshake.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Instant;

use opensesame_time::{DateTime, Utc};
use opensesame_domain::{TransportError, TrustProfileKind, TrustProfileRef};
use opensesame_transport_security::{
    GenerationCandidate, SourceOwner, TlsIdentity, TransportGenerations, TrustBundle,
};
use rustls_pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use secrecy::ExposeSecret as _;

use super::{
    GenerationHistory, GenerationLease, GenerationSink, PreparationError, PreparedHistory,
};
use crate::snapshot::SvidGeneration;

/// Adapter from [`SvidGeneration`] to the native generation manager.
#[derive(Clone)]
pub struct TransportGenerationsSink {
    generations: Arc<TransportGenerations>,
    history: Option<Arc<dyn GenerationHistory>>,
}

impl std::fmt::Debug for TransportGenerationsSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TransportGenerationsSink")
            .finish_non_exhaustive()
    }
}

impl TransportGenerationsSink {
    /// Wrap a manager.
    #[must_use]
    pub const fn new(generations: Arc<TransportGenerations>) -> Self {
        Self {
            generations,
            history: None,
        }
    }

    /// Wrap a manager with write-ahead history. The caller must first seed the
    /// manager from the complete record for the same trust owner. The plain
    /// constructor has only process-lifetime reservations and is unsuitable
    /// for Host deployments requiring durable provenance.
    #[must_use]
    pub fn with_history(
        generations: Arc<TransportGenerations>,
        history: Arc<dyn GenerationHistory>,
    ) -> Self {
        Self {
            generations,
            history: Some(history),
        }
    }

    /// The manager, for building listeners and clients.
    #[must_use]
    pub fn generations(&self) -> Arc<TransportGenerations> {
        Arc::clone(&self.generations)
    }

    /// The trust profile a trust domain's bundle is filed under: the domain
    /// name itself.
    ///
    /// # Errors
    /// A domain name that is not a valid profile name (longer than 64 bytes).
    pub fn profile_for(trust_domain: &str) -> Result<TrustProfileRef, TransportError> {
        TrustProfileRef::new(trust_domain)
    }

    /// Build the candidate without activating it.
    ///
    /// # Errors
    /// Key/chain mismatch, unusable anchors, or a domain name that cannot be
    /// a profile name.
    pub fn candidate(generation: &SvidGeneration) -> Result<GenerationCandidate, TransportError> {
        let chain: Vec<CertificateDer<'static>> = generation
            .chain_der
            .iter()
            .map(|d| CertificateDer::from(d.clone()))
            .collect();
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
            generation.key_pkcs8_der().expose_secret().clone(),
        ));
        let identity = TlsIdentity::from_der(chain, key)?;
        let mut peer_trust = BTreeMap::new();
        for domain in generation.bundles.trust_domains() {
            let profile = Self::profile_for(domain)?;
            let anchors = generation
                .bundles
                .get(domain)
                .map(<[CertificateDer<'static>]>::to_vec)
                .unwrap_or_default();
            let bundle = TrustBundle::from_der(
                profile.clone(),
                TrustProfileKind::SpiffeTrustDomain,
                anchors,
            )?
            .with_spiffe_trust_domain(domain)?;
            peer_trust.insert(profile, bundle);
        }
        Ok(GenerationCandidate {
            identity: Some(Arc::new(identity)),
            peer_trust,
            own_trust: Some(Self::profile_for(&generation.trust_domain)?),
            identity_required: true,
        })
    }
}

impl GenerationSink for TransportGenerationsSink {
    fn claim(&self) -> Result<Box<dyn GenerationLease>, TransportError> {
        let owner = self.generations.source_owner();
        let epoch = self.generations.claim_source(&owner)?;
        Ok(Box::new(TransportLease {
            generations: Arc::clone(&self.generations),
            history: self.history.clone(),
            owner,
            epoch,
            retired: false,
        }))
    }
}

struct TransportLease {
    generations: Arc<TransportGenerations>,
    history: Option<Arc<dyn GenerationHistory>>,
    owner: SourceOwner,
    epoch: u64,
    retired: bool,
}

impl TransportLease {
    fn finish_activation(&mut self, epoch: u64) -> Result<u64, TransportError> {
        self.epoch = epoch;
        if let Err(error) = self
            .generations
            .finalize_source_activation(&self.owner, epoch)
        {
            // The provisional generation may have replaced an empty or
            // already-withdrawn source, so the loop has no previous `Active`
            // entry from which to withdraw it. Withdraw this exact epoch here.
            let _ = self
                .generations
                .withdraw_from_source(&self.owner, epoch, error.clone());
            return Err(error);
        }
        Ok(epoch)
    }
}

impl GenerationLease for TransportLease {
    fn prepare(
        &mut self,
        generation: &SvidGeneration,
    ) -> Result<PreparedHistory, PreparationError> {
        self.generations
            .check_source_owner(&self.owner, self.epoch)
            .map_err(PreparationError::Lease)?;
        let candidate =
            TransportGenerationsSink::candidate(generation).map_err(PreparationError::Candidate)?;
        candidate
            .validate(Utc::now())
            .map_err(PreparationError::Candidate)?;
        let names = candidate.peer_trust.keys().cloned().collect();
        let withdrew_local_conflict = self
            .generations
            .reserve_pending_source_names(&self.owner, self.epoch, &names)
            .map_err(PreparationError::Lease)?;
        let write = match &self.history {
            Some(history) => history.reserve(names).map_err(PreparationError::History)?,
            None => Box::pin(async { Ok(()) }),
        };
        Ok(PreparedHistory {
            write,
            withdrew_local_conflict,
        })
    }

    fn activate(
        &mut self,
        generation: &SvidGeneration,
        wait_deadline: DateTime<Utc>,
        wait_monotonic: Instant,
    ) -> Result<u64, TransportError> {
        let candidate = TransportGenerationsSink::candidate(generation)?;
        let epoch = self.generations.activate_from_source_before(
            &self.owner,
            self.epoch,
            candidate,
            wait_deadline,
            wait_monotonic,
        )?;
        self.finish_activation(epoch)
    }

    fn tighten(
        &mut self,
        deadline: DateTime<Utc>,
        monotonic_deadline: Instant,
    ) -> Result<(), TransportError> {
        self.generations.tighten_source_deadline_bounded(
            &self.owner,
            self.epoch,
            deadline,
            monotonic_deadline,
        )
    }

    fn withdraw(&mut self, reason: TransportError) -> Result<(), TransportError> {
        self.generations
            .withdraw_from_source(&self.owner, self.epoch, reason)
    }

    fn retire(&mut self) -> Result<(), TransportError> {
        if !self.retired {
            self.generations.retire_source(&self.owner, self.epoch)?;
            self.retired = true;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opensesame_transport_security::testkit::DisposableCa;
    use std::time::Duration;

    #[test]
    fn failed_finalization_with_no_previous_active_generation_withdraws_the_provisional_epoch() {
        let ca = DisposableCa::new("source-history-server");
        let candidate = GenerationCandidate {
            identity: Some(Arc::new(ca.issue_server("localhost").identity())),
            identity_required: true,
            ..GenerationCandidate::default()
        };
        let initial = GenerationCandidate::default()
            .into_generation(1, Utc::now())
            .unwrap();
        let generations = TransportGenerations::new(initial);
        let owner = generations.source_owner();
        let claimed = generations.claim_source(&owner).unwrap();
        let wall_bound = Utc::now() + opensesame_time::Duration::minutes(1);
        let mono_bound = Instant::now() + Duration::from_mins(1);
        let provisional = generations
            .activate_from_source_before(&owner, claimed, candidate, wall_bound, mono_bound)
            .unwrap();
        // The identical deadline still represents an independent restriction;
        // finalization must refuse it and the sink must withdraw its epoch.
        generations
            .tighten_source_deadline_bounded(&owner, provisional, wall_bound, mono_bound)
            .unwrap();
        let mut lease = TransportLease {
            generations: Arc::clone(&generations),
            history: None,
            owner,
            epoch: claimed,
            retired: false,
        };
        assert_eq!(
            lease.finish_activation(provisional),
            Err(TransportError::GenerationStale)
        );
        assert!(generations.current().withdrawn.is_some());
        assert!(generations.checked_current(None).is_err());
    }
}
