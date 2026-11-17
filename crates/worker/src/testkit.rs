//! Disposable, real worker listeners for integration tests.
//!
//! These fixtures bind only an ephemeral loopback port, never change process
//! environment, and use the same routers and admission checks as `worker run`.
//! Their tokens and generated certificate authority are for tests only.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use opensesame_domain::transport::{
    PeerIdentitySelector, ServiceBindingSet, TrustProfileKind, TrustProfileRef,
};
use opensesame_transport_security::testkit::{DisposableCa, IssuedLeaf};
use opensesame_transport_security::{
    reqwest_builder, ClientProfile, GenerationCandidate, ServerNamePolicy, TransportGenerations,
    TrustBundle,
};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::transport::{self, SecureProfile, DEFAULT_TRUST_PROFILE};

const SERVER_DNS: &str = "worker.test";
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

/// Trust profile used for the caller-provided worker service bindings.
pub const CLIENT_TRUST_PROFILE: &str = DEFAULT_TRUST_PROFILE;

/// A worker listener with an explicit asynchronous shutdown.
///
/// Dropping it starts shutdown as a fallback, but tests should call `close`
/// to wait until the port has actually been released.
pub struct RunningWorker {
    address: SocketAddr,
    scheme: &'static str,
    shutdown: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<anyhow::Result<()>>>,
}

impl RunningWorker {
    #[must_use]
    pub fn address(&self) -> SocketAddr {
        self.address
    }

    #[must_use]
    pub fn base_url(&self) -> String {
        if self.scheme == "https" {
            format!("https://{SERVER_DNS}:{}", self.address.port())
        } else {
            format!("http://{}", self.address)
        }
    }

    /// Stop accepting, finish in-flight requests, and wait for the listener.
    ///
    /// # Errors
    ///
    /// A listener failure, task panic, or shutdown exceeding five seconds.
    pub async fn close(&mut self) -> anyhow::Result<()> {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        let Some(task) = self.task.as_mut() else {
            return Ok(());
        };
        let Ok(result) = tokio::time::timeout(CLOSE_TIMEOUT, task).await else {
            if let Some(task) = self.task.take() {
                task.abort();
                let _ = task.await;
            }
            anyhow::bail!("worker test listener shutdown timed out")
        };
        self.task = None;
        result??;
        Ok(())
    }
}

async fn finish_or_abort(mut task: JoinHandle<anyhow::Result<()>>) {
    if tokio::time::timeout(CLOSE_TIMEOUT, &mut task)
        .await
        .is_err()
    {
        task.abort();
    }
}

impl Drop for RunningWorker {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        let Some(task) = self.task.take() else {
            return;
        };
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            // Graceful shutdown also closes established TLS connections.
            drop(runtime.spawn(finish_or_abort(task)));
        } else {
            task.abort();
        }
    }
}

fn configured(ids: &[&str]) -> anyhow::Result<Vec<opensesame_domain::ProviderDefinition>> {
    if ids.is_empty() {
        anyhow::bail!("at least one workload provider is required");
    }
    // `probe_live` handles this built-in entirely in process. Other workload
    // providers can run vendor CLIs using ambient credentials or networking.
    if ids.iter().any(|id| *id != "encrypted-remote") {
        anyhow::bail!("worker testkit accepts only offline-safe providers");
    }
    crate::configured_providers(&ids.iter().map(|id| (*id).to_owned()).collect::<Vec<_>>())
}

fn running(
    address: SocketAddr,
    scheme: &'static str,
    shutdown: oneshot::Sender<()>,
    task: JoinHandle<anyhow::Result<()>>,
) -> RunningWorker {
    RunningWorker {
        address,
        scheme,
        shutdown: Some(shutdown),
        task: Some(task),
    }
}

/// Start the actual token-authenticated local worker with a test token.
///
/// # Errors
///
/// A provider outside the offline-safe test set or a loopback bind failure.
pub async fn start_local(ids: &[&str], token: String) -> anyhow::Result<RunningWorker> {
    let app = crate::local_router(configured(ids)?, token);
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let address = listener.local_addr()?;
    let (shutdown, receiver) = oneshot::channel();
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = receiver.await;
            })
            .await
            .map_err(anyhow::Error::new)
    });
    Ok(running(address, "http", shutdown, task))
}

/// A real mTLS worker and its disposable, in-memory test CA.
pub struct MtlsWorker {
    server: RunningWorker,
    ca: DisposableCa,
}

impl MtlsWorker {
    #[must_use]
    pub fn address(&self) -> SocketAddr {
        self.server.address()
    }

    #[must_use]
    pub fn base_url(&self) -> String {
        self.server.base_url()
    }

    /// Issue a test client certificate. Admission still requires a matching
    /// binding and operation; a certificate alone grants no authority.
    ///
    /// # Panics
    ///
    /// If test key generation, signing, or SAN encoding fails.
    #[must_use]
    pub fn issue_client(&self, selector: PeerIdentitySelector) -> IssuedLeaf {
        self.ca.issue_client(selector)
    }

    /// Build an HTTP client that trusts this worker and connects to its
    /// loopback port. `None` deliberately sends no client certificate.
    ///
    /// # Errors
    ///
    /// The test trust bundle, client identity, or HTTP client is invalid.
    pub fn client(&self, leaf: Option<&IssuedLeaf>) -> anyhow::Result<reqwest::Client> {
        let trust = TrustBundle::from_pem(
            TrustProfileRef::new("test-server")?,
            TrustProfileKind::PrivateRoot,
            &self.ca.ca_pem(),
        )?;
        let profile = ClientProfile {
            server_trust: trust,
            server_name: ServerNamePolicy::Dns(SERVER_DNS.into()),
            identity: leaf
                .map(|item| item.try_identity().map(Arc::new))
                .transpose()?,
            min_version: opensesame_domain::transport::TlsVersion::Tls13,
        };
        let builder = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .pool_max_idle_per_host(0)
            .resolve_to_addrs(SERVER_DNS, &[self.address()]);
        Ok(reqwest_builder(&profile, builder)?.build()?)
    }

    /// Stop the listener and release its port.
    ///
    /// # Errors
    ///
    /// As [`RunningWorker::close`].
    pub async fn close(&mut self) -> anyhow::Result<()> {
        self.server.close().await
    }
}

/// Start the actual mTLS worker with a fresh CA and the caller's bindings.
/// An empty binding set authorizes no service operations.
///
/// # Errors
///
/// A provider outside the offline-safe test set, invalid binding set or TLS
/// profile, or a loopback bind failure.
///
/// # Panics
///
/// If disposable test key generation or certificate signing fails.
pub async fn start_mtls(ids: &[&str], bindings: ServiceBindingSet) -> anyhow::Result<MtlsWorker> {
    let providers = configured(ids)?;
    bindings.validate()?;
    let ca = DisposableCa::new("worker-test-ca");
    let server = ca.issue_server(SERVER_DNS);
    let trust_profile = TrustProfileRef::new(DEFAULT_TRUST_PROFILE)?;
    let trust = TrustBundle::from_pem(
        trust_profile.clone(),
        TrustProfileKind::PrivateRoot,
        &ca.ca_pem(),
    )?;
    let mut candidate = GenerationCandidate {
        identity: Some(Arc::new(server.identity())),
        identity_required: true,
        ..GenerationCandidate::default()
    };
    candidate.peer_trust.insert(trust_profile.clone(), trust);
    let profile = SecureProfile {
        listen: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        generations: TransportGenerations::new(candidate.into_generation(1, chrono::Utc::now())?),
        trust_profile,
        bindings: Arc::new(bindings),
    };
    let listener = transport::bind(&profile).await?;
    let address = listener.local_addr();
    let app = crate::secure_router(providers, &profile);
    let (shutdown, receiver) = oneshot::channel();
    let task = tokio::spawn(async move {
        listener
            .serve_until(app, async {
                let _ = receiver.await;
            })
            .await
            .map_err(anyhow::Error::new)
    });
    Ok(MtlsWorker {
        server: running(address, "https", shutdown, task),
        ca,
    })
}
