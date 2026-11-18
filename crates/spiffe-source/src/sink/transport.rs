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

use chrono::{DateTime, Utc};
use opensesame_domain::{TransportError, TrustProfileKind, TrustProfileRef};
use opensesame_transport_security::{
    GenerationCandidate, SourceOwner, TlsIdentity, TransportGenerations, TrustBundle,
};
use rustls_pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use secrecy::ExposeSecret as _;

use super::{GenerationLease, GenerationSink};
use crate::snapshot::SvidGeneration;

/// Adapter from [`SvidGeneration`] to the native generation manager.
#[derive(Clone)]
pub struct TransportGenerationsSink {
    generations: Arc<TransportGenerations>,
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
        Self { generations }
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
            owner,
            epoch,
            retired: false,
        }))
    }
}

struct TransportLease {
    generations: Arc<TransportGenerations>,
    owner: SourceOwner,
    epoch: u64,
    retired: bool,
}

impl GenerationLease for TransportLease {
    fn activate(&mut self, generation: &SvidGeneration) -> Result<u64, TransportError> {
        let candidate = TransportGenerationsSink::candidate(generation)?;
        let epoch = self
            .generations
            .activate_from_source(&self.owner, self.epoch, candidate)?;
        self.epoch = epoch;
        Ok(epoch)
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
