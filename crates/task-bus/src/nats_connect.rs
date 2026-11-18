//! Building `async_nats::ConnectOptions` from a [`NatsTransportSpec`].
//!
//! One path for every NATS client the Host opens: the verifier is
//! `opensesame_transport_security::client_config` (`WebPKI` reference identity
//! or exact SPIFFE ID against the configured bundle), so a NATS connection
//! is checked by the same code as every other outbound TLS connection.
//!
//! On a TLS profile the client is told to `require_tls` (async-nats then
//! upgrades every connection — first and every reconnect — regardless of the
//! server's INFO), to `ignore_discovered_servers` (an `INFO.connect_urls`
//! entry can never add an egress destination the operator did not list) and
//! to `retain_servers_order` (fail over only along the operator's list).
//! Injected trust or identity makes the captured TLS config single-use, so
//! another certificate-verification attempt needs a new session config.

use std::sync::Arc;

use async_nats::{ConnectOptions, Event};
use opensesame_domain::transport::{IdentitySourceKind, TransportError, TrustProfileRef};
use opensesame_transport_security::env::read_pem_identity;
use opensesame_transport_security::svid_profile::{
    presented_spiffe_id, validate_leaf, SvidExpectation, SvidRole,
};
use opensesame_transport_security::{
    client_config, client_config_single_handshake, ClientProfile, NativeIdentitySpec,
    NativeTrustSpec, ServerNamePolicy, TlsIdentity, TrustBundle,
};
use serde::{Deserialize, Serialize};

use crate::nats_policy::{NatsAuth, NatsServerName};
use crate::nats_transport::{reconnect_limit, NatsTransportSpec};
use crate::nats_transport_env::read_seed;

pub use crate::nats::rotation::BusHealth;

/// The least-privilege identity a client runs as. Decides the client name
/// the server sees and which `JetStream` API calls the adapter makes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NatsRole {
    /// Host runtime: publishes `opensesame.events.>` and drains its own
    /// durable consumer. Never creates streams.
    Host,
    /// Publish only (`opensesame.events.>`); no `$JS.API.*` at all.
    Publisher,
    /// Durable pull on its own consumer only.
    Consumer,
    /// Backup wakes: durable pull filtered to `opensesame.events.system.>`.
    Backup,
    /// One-time stream/consumer creation.
    Provisioner,
    /// Auth-callout responder (`$SYS.REQ.USER.AUTH` in the AUTH account).
    /// Never a `TaskBus`; listed so the name and the permission set exist.
    Callout,
}

impl NatsRole {
    #[must_use]
    pub fn client_name(self) -> &'static str {
        match self {
            Self::Host => "opensesame-host",
            Self::Publisher => "opensesame-publisher",
            Self::Consumer => "opensesame-consumer",
            Self::Backup => "opensesame-backup",
            Self::Provisioner => "opensesame-provisioner",
            Self::Callout => "opensesame-callout",
        }
    }

    /// Whether this role drains a durable consumer.
    #[must_use]
    pub fn consumes(self) -> bool {
        matches!(
            self,
            Self::Host | Self::Consumer | Self::Backup | Self::Provisioner
        )
    }

    /// Whether this role publishes events.
    #[must_use]
    pub fn publishes(self) -> bool {
        matches!(self, Self::Host | Self::Publisher | Self::Provisioner)
    }
}

/// A stable, secret-free reason code for a client event.
#[must_use]
pub fn event_code(event: &Event) -> String {
    match event {
        Event::Connected => "connected".into(),
        Event::Disconnected => "disconnected".into(),
        Event::LameDuckMode => "lame_duck".into(),
        Event::Draining => "draining".into(),
        Event::Closed => "closed".into(),
        Event::SlowConsumer(_) => "slow_consumer".into(),
        Event::ServerError(async_nats::ServerError::AuthorizationViolation) => {
            "server_error:authorization_violation".into()
        }
        Event::ServerError(async_nats::ServerError::SlowConsumer(_)) => {
            "server_error:slow_consumer".into()
        }
        Event::ServerError(async_nats::ServerError::Other(_)) => "server_error:other".into(),
        Event::ClientError(async_nats::ClientError::MaxReconnects) => {
            "client_error:max_reconnects".into()
        }
        Event::ClientError(async_nats::ClientError::ServerNotInPool) => {
            "client_error:server_not_in_pool".into()
        }
        Event::ClientError(async_nats::ClientError::Other(_)) => "client_error:other".into(),
    }
}

/// Material loaded for one connection. Dropped with the options.
pub(crate) struct Material {
    pub identity: Option<Arc<TlsIdentity>>,
    pub trust: Option<TrustBundle>,
}

/// Hook for callers that hold material the env resolver cannot load
/// (managed certificates, SPIFFE SVIDs): supply it here instead. A PEM-file
/// locator cannot be overridden by injection. For a policy without a locator,
/// the caller is responsible for the material's source and provenance.
#[derive(Clone, Default)]
pub struct InjectedMaterial {
    pub identity: Option<Arc<TlsIdentity>>,
    pub trust: Option<TrustBundle>,
}

fn load_identity(spec: &NativeIdentitySpec) -> Result<Arc<TlsIdentity>, TransportError> {
    match spec {
        NativeIdentitySpec::PemFiles { cert, key } => read_pem_identity(cert, key).map(Arc::new),
        NativeIdentitySpec::ManagedCertificate { .. } | NativeIdentitySpec::Spiffe { .. } => {
            Err(TransportError::SourceUnsupported)
        }
    }
}

fn check_spiffe_client(
    identity: &TlsIdentity,
    expected: Option<&str>,
) -> Result<(), TransportError> {
    let leaf = identity
        .chain()
        .first()
        .ok_or(TransportError::IdentityMissing)?;
    let id = presented_spiffe_id(leaf.as_ref()).map_err(|_| TransportError::IdentityMissing)?;
    if expected.is_some_and(|expected| id.to_string() != expected) {
        return Err(TransportError::IdentityMissing);
    }
    validate_leaf(
        leaf.as_ref(),
        &SvidExpectation {
            trust_domain: id.trust_domain().as_str(),
            spiffe_id: None,
            role: SvidRole::Client,
        },
        std::time::SystemTime::now().into(),
    )
    .map_err(|_| TransportError::IdentityMissing)?;
    Ok(())
}

fn check_crl_pem_envelopes(pem: &[u8]) -> Result<(), TransportError> {
    let text = std::str::from_utf8(pem)
        .map_err(|_| TransportError::malformed("invalid CRL PEM envelope"))?;
    let mut inside = false;
    let mut complete = false;
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        match line {
            "-----BEGIN X509 CRL-----" if !inside => inside = true,
            "-----END X509 CRL-----" if inside => {
                inside = false;
                complete = true;
            }
            _ if inside && !line.starts_with("-----") => {}
            _ => return Err(TransportError::malformed("invalid CRL PEM envelope")),
        }
    }
    if inside || !complete {
        return Err(TransportError::malformed("invalid CRL PEM envelope"));
    }
    Ok(())
}

fn load_trust(name: &str, spec: &NativeTrustSpec) -> Result<TrustBundle, TransportError> {
    match spec {
        NativeTrustSpec::PemFile { path, kind } => {
            let pem = std::fs::read(path).map_err(|e| {
                TransportError::MalformedConfiguration(format!("trust bundle file: {e}"))
            })?;
            TrustBundle::from_pem(TrustProfileRef::new(name)?, *kind, &pem)
        }
        NativeTrustSpec::SpiffeTrustDomain { .. } => Err(TransportError::SourceUnsupported),
    }
}

/// Load (or take injected) material for a *normalized* spec.
pub(crate) fn load_material(
    spec: &NatsTransportSpec,
    injected: &InjectedMaterial,
) -> Result<Material, TransportError> {
    if injected.identity.is_some() && spec.transport.client_identity.is_none() {
        return Err(TransportError::malformed(
            "injected client identity has no configured identity reference",
        ));
    }
    if !spec.is_secure() {
        if injected.trust.is_some() {
            return Err(TransportError::TrustUnknown);
        }
        return Ok(Material {
            identity: None,
            trust: None,
        });
    }
    let trust = match (
        &injected.trust,
        &spec.locators.trust,
        &spec.transport.server_trust,
    ) {
        (Some(bundle), locator, Some(_)) => {
            if matches!(locator, Some(NativeTrustSpec::PemFile { .. })) {
                return Err(TransportError::EnforcementUnsupported);
            }
            if let Some(NativeTrustSpec::SpiffeTrustDomain { trust_domain, .. }) = locator {
                if bundle.spiffe_trust_domain() != Some(trust_domain.as_str()) {
                    return Err(TransportError::TrustUnknown);
                }
            }
            bundle.clone()
        }
        (None, Some(locator), Some(reference)) => load_trust(&reference.name, locator)?,
        _ => return Err(TransportError::TrustUnknown),
    };
    let reference = spec
        .transport
        .server_trust
        .as_ref()
        .ok_or(TransportError::TrustUnknown)?;
    if trust.profile().name != reference.name || trust.kind() != reference.kind {
        return Err(TransportError::TrustUnknown);
    }
    // The pinned verifier selects the first authoritative CRL. Refuse
    // multiple supplied lists rather than silently ignore one of them.
    if trust.crls().len() > 1 {
        return Err(TransportError::EnforcementUnsupported);
    }
    let trust = match spec.locators.crl_file.as_deref() {
        Some(path) => {
            // webpki uses the first authoritative CRL; merging independent
            // CRL sets can silently ignore a revocation from one of them.
            let prior_count = trust.crls().len();
            let pem = std::fs::read(path)
                .map_err(|error| TransportError::malformed(format!("crl file: {error}")))?;
            check_crl_pem_envelopes(&pem)?;
            let with_crls = trust.with_crls(&pem)?;
            if with_crls.crls().len() == prior_count {
                return Err(TransportError::malformed("configured CRL file is empty"));
            }
            if with_crls.crls().len() > 1 {
                return Err(TransportError::EnforcementUnsupported);
            }
            with_crls
        }
        None => trust,
    };
    let identity = match (
        &injected.identity,
        &spec.locators.identity,
        &spec.transport.client_identity,
    ) {
        (Some(_), Some(NativeIdentitySpec::PemFiles { .. }), _) => {
            return Err(TransportError::EnforcementUnsupported)
        }
        (Some(identity), Some(NativeIdentitySpec::Spiffe { spiffe_id, .. }), _) => {
            check_spiffe_client(identity, Some(spiffe_id.as_str()))?;
            Some(Arc::clone(identity))
        }
        (Some(identity), None, Some(reference))
            if reference.kind == IdentitySourceKind::SpiffeWorkloadApi =>
        {
            check_spiffe_client(identity, None)?;
            Some(Arc::clone(identity))
        }
        (Some(identity), _, _) => Some(Arc::clone(identity)),
        (None, Some(locator), Some(_)) => Some(load_identity(locator)?),
        (None, None, Some(_)) => return Err(TransportError::IdentityMissing),
        (None, _, None) => None,
    };
    Ok(Material {
        identity,
        trust: Some(trust),
    })
}

/// Build the rustls configuration through transport-security.
pub(crate) fn tls_config(
    spec: &NatsTransportSpec,
    material: &Material,
    injected: bool,
) -> Result<async_nats::rustls::ClientConfig, TransportError> {
    let trust = material.trust.clone().ok_or(TransportError::TrustUnknown)?;
    let server_name = match &spec.transport.server_name {
        Some(NatsServerName::Dns(name)) => ServerNamePolicy::Dns(name.clone()),
        Some(NatsServerName::SpiffeId(id)) => ServerNamePolicy::SpiffeId(id.clone()),
        None => {
            return Err(TransportError::MalformedConfiguration(
                "server name unresolved".into(),
            ))
        }
    };
    let profile = ClientProfile {
        server_trust: trust,
        server_name,
        identity: material.identity.clone(),
        min_version: spec.transport.min_version,
    };
    if injected {
        client_config_single_handshake(&profile)
    } else {
        client_config(&profile)
    }
}

/// Build the connect options for a normalized spec.
///
/// # Errors
///
/// `TransportError` for missing/invalid material or a policy the client
/// cannot honour; the connection is never attempted in that case.
pub async fn connect_options(
    spec: &NatsTransportSpec,
    role: NatsRole,
    injected: &InjectedMaterial,
    health: Arc<BusHealth>,
) -> Result<ConnectOptions, TransportError> {
    let material = load_material(spec, injected)?;
    let injected_session = injected.trust.is_some() || injected.identity.is_some();
    let mut options = ConnectOptions::new()
        .name(role.client_name())
        .max_reconnects(reconnect_limit(injected_session, spec.max_reconnects))
        .event_callback(move |event| {
            let health = Arc::clone(&health);
            async move {
                health.record(&event);
                tracing::info!(code = %event_code(&event), role = role.client_name(), "nats client event");
            }
        });
    if spec.is_secure() {
        let config = tls_config(spec, &material, injected_session)?;
        options = options
            .require_tls(true)
            .tls_client_config(config)
            .ignore_discovered_servers()
            .retain_servers_order();
        if spec.transport.tls_first {
            options = options.tls_first();
        }
    }
    options = match &spec.auth {
        NatsAuth::None => options,
        NatsAuth::Nkey { .. } => {
            let path = spec
                .locators
                .nkey_seed_file
                .as_deref()
                .ok_or(TransportError::IdentityMissing)?;
            options.nkey(read_seed(path)?)
        }
        NatsAuth::Creds { .. } => {
            let path = spec
                .locators
                .creds_file
                .as_deref()
                .ok_or(TransportError::IdentityMissing)?;
            options.credentials_file(path).await.map_err(|e| {
                TransportError::MalformedConfiguration(format!("credentials file: {e}"))
            })?
        }
    };
    Ok(options)
}
