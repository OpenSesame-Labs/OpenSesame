//! An opt-in, in-process fixture for selected real daemon routes.

use std::sync::PoisonError;
use std::{future::IntoFuture, io, time::Duration};

use axum::Router;
use tokio::net::TcpListener;
use tokio::sync::{oneshot, watch};
use uuid::Uuid;

use crate::{routes, App, HostSession};

const DRAIN_TIMEOUT: Duration = Duration::from_millis(500);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(3);

/// A fresh daemon fixture. It never reads a user's store or settings.
///
/// It mounts the same handlers as the daemon, with in-memory state and
/// a newly generated operator token. Only the routes named in the crate's
/// testkit documentation are mounted; there is no upstream or discovery access.
pub struct DaemonTestkit {
    state: App,
}

impl Default for DaemonTestkit {
    fn default() -> Self {
        Self::new()
    }
}

impl DaemonTestkit {
    /// Create an isolated fixture with no sessions or capabilities.
    #[must_use]
    pub fn new() -> Self {
        let mut state = super::test_state("http://127.0.0.1:1");
        state.operator_token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        Self { state }
    }

    /// The fixture-only credential accepted by operator routes.
    #[must_use]
    pub fn operator_token(&self) -> &str {
        &self.state.operator_token
    }

    /// Seed a session for a test; this does not perform sign-in.
    pub fn seed_session(&self, id: &str, principal: &str) {
        self.state
            .sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(
                id.to_owned(),
                HostSession {
                    id: id.to_owned(),
                    principal: principal.to_owned(),
                    _refresh_sealed: true,
                },
            );
    }

    /// Return the actual handlers as an Axum service for `oneshot` tests.
    /// Clones share this fixture's state, but not the state of another fixture.
    pub fn router(&self) -> Router {
        routes::local_routes().with_state(self.state.clone())
    }

    /// Serve the same router on an ephemeral IPv4 loopback port.
    ///
    /// # Errors
    ///
    /// Returns an error when the loopback socket cannot be bound.
    pub async fn start(&self) -> io::Result<RunningDaemon> {
        start_router(self.router()).await
    }
}

// Axum owns independent connection tasks. A private runtime lets us give those
// tasks time to finish and then cancel all survivors before reporting closure.
async fn start_router(router: Router) -> io::Result<RunningDaemon> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    listener.set_nonblocking(true)?;
    let address = listener.local_addr()?;
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let (ready_tx, ready_rx) = oneshot::channel();
    let (closed_tx, closed_rx) = oneshot::channel();
    std::thread::Builder::new()
        .name("opensesame-daemon-testkit".into())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                    return;
                }
            };
            let result = runtime.block_on(async move {
                let listener = match TcpListener::from_std(listener) {
                    Ok(listener) => listener,
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                        return Ok(());
                    }
                };
                if ready_tx.send(Ok(())).is_err() {
                    return Ok(());
                }
                serve_until_closed(listener, router, shutdown_rx).await
            });
            // Dropping the runtime cancels the connection tasks Axum spawned,
            // including handlers that exceeded the graceful drain period.
            drop(runtime);
            let _ = closed_tx.send(result);
        })?;
    ready_rx
        .await
        .map_err(|_| io::Error::other("daemon testkit did not start"))??;
    Ok(RunningDaemon {
        address,
        shutdown: Some(shutdown_tx),
        closed: Some(closed_rx),
    })
}

async fn serve_until_closed(
    listener: TcpListener,
    router: Router,
    mut shutdown: watch::Receiver<bool>,
) -> io::Result<()> {
    let mut signal = shutdown.clone();
    let server = axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            let _ = signal.changed().await;
        })
        .into_future();
    tokio::pin!(server);
    tokio::select! {
        result = &mut server => result,
        _ = shutdown.changed() => {
            // A timeout is followed by dropping this runtime, which cancels
            // the remaining connection tasks rather than leaving them behind.
            match tokio::time::timeout(DRAIN_TIMEOUT, &mut server).await {
                Ok(result) => result,
                Err(_) => Ok(()),
            }
        }
    }
}

/// A loopback server owned by a test. Drop starts shutdown; `close` waits for it.
pub struct RunningDaemon {
    address: std::net::SocketAddr,
    shutdown: Option<watch::Sender<bool>>,
    closed: Option<oneshot::Receiver<io::Result<()>>>,
}

impl RunningDaemon {
    /// Base URL for an ordinary HTTP client.
    #[must_use]
    pub fn base_url(&self) -> String {
        format!("http://{}", self.address)
    }

    /// Stop the server and wait until its listener and connection tasks end.
    ///
    /// # Errors
    ///
    /// Returns a server error or an error if shutdown could not be confirmed
    /// within the bounded wait.
    pub async fn close(mut self) -> io::Result<()> {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(true);
        }
        let Some(closed) = self.closed.take() else {
            return Ok(());
        };
        match tokio::time::timeout(CLOSE_TIMEOUT, closed).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(io::Error::other(
                "daemon testkit thread stopped unexpectedly",
            )),
            Err(_) => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "daemon testkit shutdown did not finish",
            )),
        }
    }
}

impl Drop for RunningDaemon {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(true);
        }
    }
}

#[cfg(test)]
#[path = "harness_tests.rs"]
mod tests;
