//! Own the loopback listener and all tasks Axum creates for it.

use std::{future::IntoFuture, io, time::Duration};

use axum::Router;
use tokio::{
    net::TcpListener,
    sync::{oneshot, watch},
};

const DRAIN_TIMEOUT: Duration = Duration::from_millis(500);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(3);

pub(super) async fn start(router: Router) -> io::Result<RunningHost> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    listener.set_nonblocking(true)?;
    let address = listener.local_addr()?;
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let (ready_tx, ready_rx) = oneshot::channel();
    let (closed_tx, closed_rx) = oneshot::channel();
    std::thread::Builder::new()
        .name("opensesame-host-testkit".into())
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
            // Axum's per-connection tasks belong to this runtime too.
            drop(runtime);
            let _ = closed_tx.send(result);
        })?;
    ready_rx
        .await
        .map_err(|_| io::Error::other("Host testkit did not start"))??;
    Ok(RunningHost {
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
            match tokio::time::timeout(DRAIN_TIMEOUT, &mut server).await {
                Ok(result) => result,
                // Runtime teardown cancels the remaining connection tasks.
                Err(_) => Ok(()),
            }
        }
    }
}

/// A loopback Host owned by a test. Drop initiates shutdown; `close` waits.
pub struct RunningHost {
    address: std::net::SocketAddr,
    shutdown: Option<watch::Sender<bool>>,
    closed: Option<oneshot::Receiver<io::Result<()>>>,
}

impl RunningHost {
    /// Base URL for an ordinary HTTP client.
    #[must_use]
    pub fn base_url(&self) -> String {
        format!("http://{}", self.address)
    }

    /// Stop the listener and wait for its connection tasks to finish.
    ///
    /// # Errors
    ///
    /// Returns a server error or an error if shutdown cannot be confirmed.
    pub async fn close(mut self) -> io::Result<()> {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(true);
        }
        let Some(closed) = self.closed.take() else {
            return Ok(());
        };
        match tokio::time::timeout(CLOSE_TIMEOUT, closed).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(io::Error::other("Host testkit thread stopped unexpectedly")),
            Err(_) => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Host testkit shutdown did not finish",
            )),
        }
    }
}

impl Drop for RunningHost {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(true);
        }
    }
}

#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;
