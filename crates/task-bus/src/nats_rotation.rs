//! Serialized NATS session rotation and session-scoped health observations.

use std::future::Future;
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::time::Duration;

use async_nats::Event;

use super::{open_session, InjectedMaterial, NatsJetStreamConfig, NatsJetStreamTaskBus, Session};
use crate::nats_connect::event_code;
use crate::nats_transport::NatsTransportSpec;

async fn drain_previous<E: std::fmt::Display>(drain: impl Future<Output = Result<(), E>>) -> bool {
    match tokio::time::timeout(Duration::from_secs(2), drain).await {
        Ok(Ok(())) => true,
        Ok(Err(error)) => {
            tracing::warn!(%error, "draining the previous NATS connection failed");
            false
        }
        Err(_) => {
            tracing::warn!("draining the previous NATS connection timed out");
            false
        }
    }
}

pub(super) struct Accepted {
    pub(super) transport: NatsTransportSpec,
    pub(super) injected: InjectedMaterial,
}

#[derive(Default)]
struct HealthState {
    connected: bool,
    saw_connected: bool,
    disconnects: u64,
    reconnects: u64,
    last_event: Option<String>,
}

/// Connection health as observed through the active client's event callback.
/// Reason codes only — never a credential, never a URL with userinfo.
/// A handle returned before rotation continues to observe the accepted client.
#[derive(Default)]
pub struct BusHealth {
    current: RwLock<Arc<Mutex<HealthState>>>,
}

impl BusHealth {
    fn state(&self) -> Arc<Mutex<HealthState>> {
        Arc::clone(&self.current.read().unwrap_or_else(PoisonError::into_inner))
    }

    #[must_use]
    pub fn connected(&self) -> bool {
        let state = self.state();
        let guard = state.lock().unwrap_or_else(PoisonError::into_inner);
        guard.connected
    }

    #[must_use]
    pub fn disconnects(&self) -> u64 {
        let state = self.state();
        let guard = state.lock().unwrap_or_else(PoisonError::into_inner);
        guard.disconnects
    }

    #[must_use]
    pub fn reconnects(&self) -> u64 {
        let state = self.state();
        let guard = state.lock().unwrap_or_else(PoisonError::into_inner);
        guard.reconnects
    }

    /// The last reason code (`connected`, `disconnected`, `closed`,
    /// `server_error:authorization_violation`, ...).
    #[must_use]
    pub fn last_event(&self) -> Option<String> {
        let state = self.state();
        let guard = state.lock().unwrap_or_else(PoisonError::into_inner);
        guard.last_event.clone()
    }

    pub(crate) fn record(&self, event: &Event) {
        let state = self.state();
        let mut guard = state.lock().unwrap_or_else(PoisonError::into_inner);
        match event {
            Event::Connected => {
                if guard.saw_connected || guard.disconnects > 0 {
                    guard.reconnects = guard.reconnects.saturating_add(1);
                }
                guard.saw_connected = true;
                guard.connected = true;
            }
            Event::Disconnected | Event::Closed => {
                guard.connected = false;
                guard.disconnects = guard.disconnects.saturating_add(1);
            }
            _ => {}
        }
        guard.last_event = Some(event_code(event));
    }

    /// Keep the observer handle stable while replacing its event source.
    pub(crate) fn adopt(&self, candidate: &Self) {
        let next = candidate.state();
        let mut current = self.current.write().unwrap_or_else(PoisonError::into_inner);
        if Arc::ptr_eq(&current, &next) {
            return;
        }
        {
            let prior = current.lock().unwrap_or_else(PoisonError::into_inner);
            let mut accepted = next.lock().unwrap_or_else(PoisonError::into_inner);
            if accepted.connected && (prior.saw_connected || prior.disconnects > 0) {
                accepted.reconnects = accepted.reconnects.saturating_add(1);
            }
            accepted.saw_connected |= prior.saw_connected;
            accepted.disconnects = accepted.disconnects.saturating_add(prior.disconnects);
            accepted.reconnects = accepted.reconnects.saturating_add(prior.reconnects);
        }
        *current = next;
    }
}

impl NatsJetStreamTaskBus {
    pub(super) fn accepted(&self) -> Arc<Accepted> {
        Arc::clone(&self.accepted.read().unwrap_or_else(PoisonError::into_inner))
    }

    /// Open a replacement and atomically publish its session and metadata.
    /// Rotations queue in the order they acquire the asynchronous mutex;
    /// `None` reuses the most recently accepted injected material. Operations
    /// holding the old session read lock finish before it is replaced. A
    /// synchronous view can observe the preceding view while a commit is in
    /// progress; it is not a combined transaction with a separate health read.
    /// After publication, the old drain enqueue is bounded; returning does not
    /// establish that the prior connection or background task has closed.
    ///
    /// # Errors
    ///
    /// As [`Self::connect`]; on error the accepted session remains active.
    pub async fn rotate(
        &self,
        transport: NatsTransportSpec,
        injected: Option<InjectedMaterial>,
    ) -> anyhow::Result<()> {
        self.rotate_using(transport, injected, |config, material, health| async move {
            open_session(&config, &material, health).await
        })
        .await
    }

    pub(super) async fn rotate_using<F, Fut>(
        &self,
        transport: NatsTransportSpec,
        injected: Option<InjectedMaterial>,
        open: F,
    ) -> anyhow::Result<()>
    where
        F: FnOnce(NatsJetStreamConfig, InjectedMaterial, Arc<BusHealth>) -> Fut,
        Fut: Future<Output = anyhow::Result<Session>>,
    {
        let rotation = self.rotations.lock().await;
        let mut config = self.config.clone();
        config.transport = transport;
        config.provision = false;
        let material = injected.unwrap_or_else(|| self.accepted().injected.clone());
        let health = Arc::new(BusHealth::default());
        let fresh = open(config, material, Arc::clone(&health)).await?;
        let accepted = Arc::clone(&fresh.accepted);
        let old = {
            let mut session = self.session.write().await;
            let mut current = self
                .accepted
                .write()
                .unwrap_or_else(PoisonError::into_inner);
            let old = std::mem::replace(&mut *session, fresh);
            *current = accepted;
            self.health.adopt(&health);
            old
        };
        // A later rotation may start after this commit; it can never publish
        // before an older opening attempt or drain the newer connection.
        drop(rotation);
        let _ = drain_previous(old.client.drain()).await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn pending_old_session_drain_cannot_block_rotation() {
        assert!(drain_previous(async { Ok::<(), std::io::Error>(()) }).await);
        let (sender, receiver) = tokio::sync::mpsc::channel(1);
        sender.send(()).await.unwrap();
        assert!(
            !tokio::time::timeout(Duration::from_secs(4), drain_previous(sender.send(())))
                .await
                .expect("old drain exceeded its bound")
        );
        assert_eq!(receiver.len(), 1, "the full queue was not drained");
    }
}
