//! The Host's transport runtime: the generations a listener serves, the live
//! service-binding set, and the facts the operator status route reports.
//!
//! Building it is the whole of EXPLICIT-ENFORCEMENT for the Host. A
//! deployment that configured nothing gets `None` and every service purpose
//! stays unreachable. A deployment that configured a listener gets a runtime
//! or an error — there is no third outcome where a required profile quietly
//! serves plaintext. Identity material is resolved through exactly three
//! sources (PEM files, a managed certificate reference, the SPIFFE Workload
//! API) and a source that cannot produce a *usable* identity fails the
//! build rather than downgrading the policy.

use std::net::SocketAddr;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use opensesame_domain::transport::{
    ServiceBindingSet, TransportError, TransportPolicy, TrustProfileKind, TrustProfileRef,
};
use opensesame_domain::CredentialStatus;
use opensesame_ingress_evidence::{
    originating_peer_layer, BindingSetAdmission, IngressLimits, OriginatingPeerLayer,
};
use opensesame_spiffe_source::{
    SourcePhase, SourceStatus, SpiffeSource, SpiffeSourceConfig, SpiffeSourceHandle, WaitError,
};
use opensesame_storage::Db;
use opensesame_time::Utc;
use opensesame_transport_security::env::{NativeIdentitySpec, NativeTrustSpec};
use opensesame_transport_security::{
    env as tls_env, GenerationCandidate, TlsIdentity, TransportGenerations, TrustBundle,
};

use super::bindings::{self, BindingsSource};
use super::config::{AuthMode, ListenerConfig, TransportConfig};
use super::source_history::coordinator::{claim_host_history, ManagedHistory};
use super::status::{SharedFacts, TransportFacts};
use super::ManagedIdentityResolver;

/// How long the build waits for the Workload API to deliver the first SVID
/// before refusing to start. A `spiffe` identity that never arrives is a
/// startup failure, not a reason to serve without one.
pub const SPIFFE_FIRST_SVID_TIMEOUT: Duration = Duration::from_secs(30);

/// A first SVID may bind only when [`SourceStatus::credential_status`] is
/// [`CredentialStatus::Configured`]. Withdrawal, stop, and expiry at
/// `retain_until` or `not_after` (inclusive) are not a usable identity.
#[must_use]
pub(crate) fn spiffe_first_ready_to_bind(status: &SourceStatus) -> bool {
    matches!(
        status.credential_status(Utc::now()),
        CredentialStatus::Configured { .. }
    )
}

/// Terminal observation for the first-SVID wait: a served generation, or a
/// withdrawn or stopped source that already recorded one. Withdrawal or stop
/// with no generation leaves the wait open until timeout. A settled withdrawal
/// or stop must refuse the bind.
#[must_use]
pub(crate) fn spiffe_first_svid_settled(status: &SourceStatus) -> bool {
    spiffe_first_ready_to_bind(status)
        || (status.generation.is_some()
            && matches!(status.phase, SourcePhase::Withdrawn | SourcePhase::Stopped))
}

/// Bind only a served generation. Withdrawal, stop, a deadline with no
/// generation, a source task that exited, and a status feed that lags a
/// manager-side withdraw are [`TransportError::IdentityMissing`]: the manager
/// must still serve the observed generation when the listener binds.
pub(crate) fn conclude_spiffe_first_svid(
    ready: Result<SourceStatus, WaitError>,
    generations: &TransportGenerations,
) -> Result<(), TransportError> {
    match ready {
        Ok(status) if spiffe_first_ready_to_bind(&status) => generations
            .checked_current(status.generation)
            .map(|_| ())
            .map_err(|_| TransportError::IdentityMissing),
        Ok(_) | Err(WaitError::DeadlineElapsed(_) | WaitError::StatusTaskGone(_)) => {
            Err(TransportError::IdentityMissing)
        }
    }
}

/// Everything the Host's secure listener, service admission and operator
/// routes read.
pub struct TransportRuntime {
    /// Atomically swapped credential/trust generations.
    pub generations: Arc<TransportGenerations>,
    /// The live service-binding set, shared with the ingress admission.
    pub bindings: Arc<RwLock<ServiceBindingSet>>,
    /// Where the live set came from (env file, store, or the empty default).
    pub bindings_source: BindingsSource,
    /// The secure listener's policy (`ExistingLocal` when none is configured).
    pub policy: TransportPolicy,
    /// The secure listener's address, when one is configured.
    pub listen: Option<SocketAddr>,
    /// The listener id stamped into every `ListenerProvenance`.
    pub listener_id: String,
    /// The trust profile peers of this listener are bound under.
    pub client_trust_profile: TrustProfileRef,
    /// Observed authentication and probe results.
    pub status: SharedFacts,
    pub mapping_auth: AuthMode,
    pub callout_auth: AuthMode,
    /// The configuration this runtime was built from.
    pub config: TransportConfig,
    /// Present only on the `trusted_ingress` profile.
    pub ingress_layer: Option<OriginatingPeerLayer>,
    /// Kept alive for the process lifetime when the identity is a SPIFFE SVID.
    pub spiffe: Option<SpiffeSourceHandle>,
}

impl std::fmt::Debug for TransportRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TransportRuntime")
            .field("policy", &self.policy)
            .field("listener_id", &self.listener_id)
            .field("bindings_source", &self.bindings_source)
            .field("generation", &self.generations.current().number)
            .finish_non_exhaustive()
    }
}

impl TransportRuntime {
    /// Build from the process environment and the Host store.
    ///
    /// `Ok(None)` when nothing about transport is configured — the
    /// unconfigured optional feature, which is not an error (§ charter
    /// EXPLICIT-ENFORCEMENT). Otherwise the runtime, or the configuration's
    /// own error.
    ///
    /// # Errors
    ///
    /// Any [`TransportError`] from reading the environment, loading identity
    /// or trust material, or parsing the bindings document.
    pub async fn build(
        config: TransportConfig,
        db: &Db,
        resolver: &dyn ManagedIdentityResolver,
    ) -> Result<Option<Arc<Self>>, TransportError> {
        if config.is_unconfigured() {
            return Ok(None);
        }
        let loaded = bindings::load(db, config.service_bindings_file.as_deref()).await?;
        let bindings = Arc::new(RwLock::new(loaded.set));
        let listener = config.listener.clone();
        let (generations, spiffe) = match listener.as_ref() {
            Some(listener) => build_generations(listener, resolver, db).await?,
            None => (
                seeded_manager(db, GenerationCandidate::default())
                    .await?
                    .generations(),
                None,
            ),
        };
        let client_trust_profile = listener.as_ref().map_or_else(
            || TrustProfileRef::new(super::config::DEFAULT_CLIENT_TRUST_PROFILE),
            |l| Ok(l.client_trust_profile.clone()),
        )?;
        let ingress_layer = match listener.as_ref() {
            Some(l) if l.policy == TransportPolicy::TrustedIngress => {
                Some(build_ingress_layer(l, &bindings)?)
            }
            _ => None,
        };
        Ok(Some(Arc::new(Self {
            generations,
            bindings,
            bindings_source: loaded.source,
            policy: listener
                .as_ref()
                .map_or(TransportPolicy::ExistingLocal, |l| l.policy),
            listen: listener.as_ref().map(|l| l.listen),
            listener_id: super::HOST_TLS_LISTENER.to_owned(),
            client_trust_profile,
            status: Arc::new(RwLock::new(TransportFacts::default())),
            mapping_auth: config.mapping_auth,
            callout_auth: config.callout_auth,
            config,
            ingress_layer,
            spiffe,
        })))
    }

    /// The current generation number.
    #[must_use]
    pub fn generation(&self) -> u64 {
        self.generations.current().number
    }

    /// `(generation, activated_at, identity not_after)` for the status view.
    #[must_use]
    pub fn installed(
        &self,
    ) -> Option<(
        u64,
        opensesame_time::DateTime<opensesame_time::Utc>,
        Option<opensesame_time::DateTime<opensesame_time::Utc>>,
    )> {
        let current = self.generations.checked_current(None).ok()?;
        current.identity.as_ref().map(|identity| {
            (
                current.number,
                current.activated_at,
                Some(identity.not_after()),
            )
        })
    }

    /// The Workload API source's own truthful credential status, when the
    /// identity comes from one. Custody there is `workload_api_delivered`:
    /// the key was handed to this process, and the source — not this
    /// struct — is what knows whether it is still live.
    #[must_use]
    pub fn spiffe_credential(
        &self,
        now: opensesame_time::DateTime<opensesame_time::Utc>,
    ) -> Option<opensesame_domain::transport::CredentialStatus> {
        self.spiffe
            .as_ref()
            .map(|handle| handle.current().credential_status(now))
    }

    /// The per-listener revoked-leaf hook: a thumbprint any binding denies is
    /// refused at the handshake and again on every request of an already-open
    /// connection (AT-TLS-REVOKEDLIVE).
    #[must_use]
    pub fn deny_thumbprint_hook(&self) -> opensesame_transport_security::DenyThumbprint {
        let bindings = Arc::clone(&self.bindings);
        Arc::new(move |thumbprint: &str| {
            bindings
                .read()
                .is_ok_and(|set| super::bindings::denies_thumbprint(&set, thumbprint))
        })
    }

    /// A snapshot of the live binding set.
    #[must_use]
    pub fn binding_set(&self) -> ServiceBindingSet {
        self.bindings
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

/// A configured Host trust owner must have complete durable history before
/// any source generation or stored trust can be exposed.
async fn seeded_manager(
    db: &Db,
    candidate: GenerationCandidate,
) -> Result<ManagedHistory, TransportError> {
    let permit = tokio::time::timeout(SPIFFE_FIRST_SVID_TIMEOUT, claim_host_history())
        .await
        .map_err(|_| TransportError::malformed("source history owner claim timed out"))?
        .map_err(|error| TransportError::malformed(format!("source history: {error}")))?;
    permit
        .start_manager(db.clone(), candidate)
        .await
        .map_err(|error| TransportError::malformed(format!("source history: {error}")))
}

async fn build_generations(
    listener: &ListenerConfig,
    resolver: &dyn ManagedIdentityResolver,
    db: &Db,
) -> Result<(Arc<TransportGenerations>, Option<SpiffeSourceHandle>), TransportError> {
    if let NativeIdentitySpec::Spiffe { .. } = &listener.identity {
        return start_spiffe(listener, db).await.map(|(g, h)| (g, Some(h)));
    }
    let identity = resolve_identity(&listener.identity, resolver).await?;
    let mut candidate = GenerationCandidate {
        identity: Some(identity),
        identity_required: true,
        ..GenerationCandidate::default()
    };
    if let Some(spec) = &listener.client_trust {
        let bundle = load_trust(&listener.client_trust_profile, spec, listener)?;
        candidate
            .peer_trust
            .insert(listener.client_trust_profile.clone(), bundle);
    }
    let managed = seeded_manager(db, candidate).await?;
    Ok((managed.generations(), None))
}

/// PEM now, managed through the custody bridge. A `managed` reference the
/// bridge cannot resolve is an error here so a configured listener never
/// falls back to no identity at all.
async fn resolve_identity(
    spec: &NativeIdentitySpec,
    resolver: &dyn ManagedIdentityResolver,
) -> Result<Arc<TlsIdentity>, TransportError> {
    match spec {
        NativeIdentitySpec::PemFiles { cert, key } => {
            tls_env::read_pem_identity(cert, key).map(Arc::new)
        }
        NativeIdentitySpec::ManagedCertificate { certificate_id } => {
            resolver.resolve(certificate_id).await
        }
        NativeIdentitySpec::Spiffe { .. } => Err(TransportError::SourceUnsupported),
    }
}

fn load_trust(
    profile: &TrustProfileRef,
    spec: &NativeTrustSpec,
    listener: &ListenerConfig,
) -> Result<TrustBundle, TransportError> {
    match spec {
        NativeTrustSpec::PemFile { path, kind } => {
            let pem = std::fs::read(path)
                .map_err(|e| TransportError::malformed(format!("client trust bundle: {e}")))?;
            let bundle = TrustBundle::from_pem(profile.clone(), *kind, &pem)?;
            match &listener.crl_file {
                Some(crl) => {
                    let crl_pem = std::fs::read(crl)
                        .map_err(|e| TransportError::malformed(format!("crl file: {e}")))?;
                    bundle.with_crls(&crl_pem)
                }
                None => Ok(bundle),
            }
        }
        // The Workload API delivers the domain's bundle; a file cannot stand
        // in for it, and pretending otherwise would trust the wrong anchors.
        NativeTrustSpec::SpiffeTrustDomain { .. } => Err(TransportError::SourceUnsupported),
    }
}

/// Start the Workload API source and wait for the first SVID. The listener
/// is bound only while a generation is being served. A generation that was
/// observed and then withdrawn or stopped before this wait returns refuses
/// to bind. Withdrawal or stop before any generation does not end the wait.
async fn start_spiffe(
    listener: &ListenerConfig,
    db: &Db,
) -> Result<(Arc<TransportGenerations>, SpiffeSourceHandle), TransportError> {
    let config = SpiffeSourceConfig::from_native_spec(&listener.identity)
        .map_err(|e| e.to_transport_error())?
        .ok_or(TransportError::SourceUnsupported)?;
    let managed = seeded_manager(db, GenerationCandidate::default()).await?;
    let generations = managed.generations();
    let sink = Arc::new(managed.source_sink());
    let handle = SpiffeSource::start(config, sink)?;
    let ready = handle
        .wait_for(SPIFFE_FIRST_SVID_TIMEOUT, spiffe_first_svid_settled)
        .await;
    conclude_spiffe_first_svid(ready, &generations)?;
    Ok((generations, handle))
}

/// The trusted-ingress layer: originating-client evidence is verified against
/// its own bundle, and only for a socket peer the binding set names as an
/// ingress. The bundle is never the one that verified the ingress itself.
fn build_ingress_layer(
    listener: &ListenerConfig,
    bindings: &Arc<RwLock<ServiceBindingSet>>,
) -> Result<OriginatingPeerLayer, TransportError> {
    let path = listener
        .ingress_originating_trust_file
        .as_ref()
        .ok_or_else(|| {
            TransportError::malformed(
                "OPENSESAME_INGRESS_ORIGINATING_TRUST_FILE is required for trusted_ingress",
            )
        })?;
    let pem = std::fs::read(path)
        .map_err(|e| TransportError::malformed(format!("originating trust bundle: {e}")))?;
    let trust = Arc::new(TrustBundle::from_pem(
        TrustProfileRef::new("originating-clients")?,
        TrustProfileKind::PrivateRoot,
        &pem,
    )?);
    let admission = Arc::new(BindingSetAdmission::new(Arc::clone(bindings)));
    Ok(originating_peer_layer(
        admission,
        trust,
        IngressLimits::DEFAULT,
    ))
}
