//! The connection loop: stream snapshots from the Workload API, reduce each
//! to a generation, activate or withdraw, and bound what survives an outage.
//!
//! Snapshot semantics: every message **replaces** the prior state. A message
//! without the configured SVID, or without its trust domain's bundle, is an
//! authoritative withdrawal and is applied at once. An unparseable snapshot
//! also withdraws because the SDK cannot tell us whether it omitted the
//! configured identity or trust. A parsed candidate rejected by the profile or
//! sink retains the previous generation only when every old anchor is present
//! in the new trust view, and only within its existing time bounds. Explicit
//! permission or authentication denial withdraws, as does an empty Workload
//! API response (the same withdrawal as an empty SVID list). A transport
//! error or disconnect starts an outage: material is retained until the
//! earlier of its expiry or the outage freshness limit. Reconnection uses
//! bounded, jittered backoff; there is no fallback identity.

use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt as _;
use opensesame_domain::TransportError;
use opensesame_time::{DateTime, Utc};
use spiffe::transport::Endpoint;
use spiffe::{WorkloadApiClient, X509Context};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::config::SpiffeSourceConfig;
use crate::error::SpiffeSourceError;
use crate::outage::{bounded_deadline, retention_deadline, Backoff};
use crate::sink::GenerationSink;
use crate::snapshot::{SvidGeneration, TrustDomainBundles};
use crate::status::{SourcePhase, SourceStatus};

#[path = "source_policy.rs"]
mod source_policy;
use source_policy::{classify_api_failure, ApiAction};

/// A running source.
///
/// Dropping the handle signals the background loop to withdraw and stop.
/// [`Drop`] does not join the task: it cannot await, and aborting the task
/// would skip that terminal withdrawal. The detached task observes the flag
/// and exits. Call [`SpiffeSourceHandle::stop`] to wait until it has finished.
#[derive(Debug)]
pub struct SpiffeSourceHandle {
    status: watch::Receiver<SourceStatus>,
    stop: watch::Sender<bool>,
    /// `None` after [`SpiffeSourceHandle::stop`] has taken the task to join it.
    /// `Drop` leaves it in place so the handle drop detaches rather than joins.
    task: Option<JoinHandle<()>>,
}

/// Why [`SpiffeSourceHandle::wait_for`] returned before `pred` held.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WaitError {
    /// `timeout` elapsed. The status is the last observation.
    DeadlineElapsed(SourceStatus),
    /// The status sender was dropped because the source task ended or the
    /// channel closed. The status is the last observation.
    StatusTaskGone(SourceStatus),
}

impl std::fmt::Display for WaitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DeadlineElapsed(status) => write!(
                f,
                "deadline elapsed (phase {:?}, generation {:?})",
                status.phase, status.generation
            ),
            Self::StatusTaskGone(status) => write!(
                f,
                "status task gone (phase {:?}, generation {:?})",
                status.phase, status.generation
            ),
        }
    }
}

impl std::error::Error for WaitError {}

impl SpiffeSourceHandle {
    /// Live status feed.
    #[must_use]
    pub fn status(&self) -> watch::Receiver<SourceStatus> {
        self.status.clone()
    }

    /// Current status.
    #[must_use]
    pub fn current(&self) -> SourceStatus {
        self.status.borrow().clone()
    }

    /// Wait until `pred` holds for the status, the timeout elapses, or the
    /// status task is gone.
    ///
    /// # Errors
    /// [`WaitError::DeadlineElapsed`] when `timeout` elapses first, or
    /// [`WaitError::StatusTaskGone`] when the status sender is dropped.
    pub async fn wait_for(
        &self,
        timeout: Duration,
        pred: impl FnMut(&SourceStatus) -> bool,
    ) -> Result<SourceStatus, WaitError> {
        let mut rx = self.status.clone();
        wait_for_status(&mut rx, timeout, pred).await
    }

    /// Stop the loop; the current generation is withdrawn.
    pub async fn stop(mut self) {
        let _ = self.stop.send(true);
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

impl Drop for SpiffeSourceHandle {
    fn drop(&mut self) {
        // Signal only. Joining is intentionally skipped: `Drop` cannot await,
        // and aborting `task` would skip the loop's terminal withdrawal.
        // Dropping `JoinHandle` detaches the task; it keeps running until it
        // observes this flag and exits.
        let _ = self.stop.send(true);
    }
}

/// The source itself.
#[derive(Debug)]
pub struct SpiffeSource;

impl SpiffeSource {
    /// Start streaming from the configured socket into `sink`.
    #[must_use]
    pub fn start(config: SpiffeSourceConfig, sink: Arc<dyn GenerationSink>) -> SpiffeSourceHandle {
        let (status_tx, status_rx) = watch::channel(SourceStatus::initial(config.spiffe_id()));
        let (stop_tx, stop_rx) = watch::channel(false);
        let task = tokio::spawn(Loop::new(config, sink, status_tx, stop_rx).run());
        SpiffeSourceHandle {
            status: status_rx,
            stop: stop_tx,
            task: Some(task),
        }
    }
}

struct Loop {
    config: SpiffeSourceConfig,
    sink: Arc<dyn GenerationSink>,
    status: watch::Sender<SourceStatus>,
    stop: watch::Receiver<bool>,
    backoff: Backoff,
    active: Option<Active>,
}

/// The generation currently handed to the sink.
struct Active {
    not_after: DateTime<Utc>,
    bundles: TrustDomainBundles,
}

enum StreamEnd {
    Stop,
    Broken(SpiffeSourceError),
    Withdrawn(TransportError, &'static str),
    Expired,
}

impl Loop {
    fn new(
        config: SpiffeSourceConfig,
        sink: Arc<dyn GenerationSink>,
        status: watch::Sender<SourceStatus>,
        stop: watch::Receiver<bool>,
    ) -> Self {
        let seed = u64::try_from(Utc::now().timestamp_nanos_opt().unwrap_or(1)).unwrap_or(1);
        Self {
            backoff: Backoff::new(config.reconnect(), seed),
            config,
            sink,
            status,
            stop,
            active: None,
        }
    }

    async fn run(mut self) {
        loop {
            if *self.stop.borrow() {
                break;
            }
            match self.connect_and_stream().await {
                StreamEnd::Stop => break,
                StreamEnd::Broken(err) => self.on_outage(&err),
                StreamEnd::Withdrawn(reason, code) => self.withdraw(reason, Some(code)),
                StreamEnd::Expired => self.withdraw(TransportError::EvidenceExpired, None),
            }
            let delay = self.backoff.next_delay();
            if !self.retain_through(delay).await {
                break;
            }
        }
        self.withdraw(TransportError::SourceUnsupported, None);
        self.update(|s| s.phase = SourcePhase::Stopped);
    }

    async fn connect_and_stream(&mut self) -> StreamEnd {
        self.update(|s| {
            if matches!(s.phase, SourcePhase::Connecting | SourcePhase::Streaming) {
                s.phase = SourcePhase::Connecting;
            }
        });
        let endpoint = Endpoint::Unix(self.config.endpoint_socket().to_path_buf());
        let expiry = self.active_deadline();
        let connection = tokio::select! {
            biased;
            _ = self.stop.changed() => return StreamEnd::Stop,
            () = sleep_until(expiry) => return StreamEnd::Expired,
            connection = WorkloadApiClient::connect(endpoint) => connection,
        };
        let Ok(client) = connection else {
            return StreamEnd::Broken(SpiffeSourceError::Transport("connect".into()));
        };
        let expiry = self.active_deadline();
        let stream = tokio::select! {
            biased;
            _ = self.stop.changed() => return StreamEnd::Stop,
            () = sleep_until(expiry) => return StreamEnd::Expired,
            stream = client.stream_x509_contexts() => stream,
        };
        let mut stream = match stream {
            Ok(stream) => stream,
            Err(error) => return Self::end_action(classify_api_failure(&error), "open_stream"),
        };
        self.update(|s| {
            s.connections = s.connections.saturating_add(1);
        });
        loop {
            let expiry = self.active_deadline();
            tokio::select! {
                biased;
                _ = self.stop.changed() => return StreamEnd::Stop,
                () = sleep_until(expiry) => {
                    self.withdraw(TransportError::EvidenceExpired, None);
                }
                item = stream.next() => match item {
                    Some(Ok(ctx)) => self.apply(&ctx),
                    Some(Err(error)) => {
                        return Self::end_action(classify_api_failure(&error), "stream");
                    }
                    None => return StreamEnd::Broken(SpiffeSourceError::Transport("closed".into())),
                },
            }
        }
    }

    /// Stream-open and mid-stream failures share this exit. A withdrawal
    /// ends the stream at both points so a following EOF cannot replace the
    /// reported reason with an outage.
    fn end_action(action: ApiAction, stage: &'static str) -> StreamEnd {
        match action {
            ApiAction::Denied(code) => StreamEnd::Withdrawn(TransportError::IdentityMissing, code),
            ApiAction::Withdraw(reason, code) => StreamEnd::Withdrawn(reason, code),
            ApiAction::Outage => StreamEnd::Broken(SpiffeSourceError::Transport(stage.into())),
        }
    }

    fn active_deadline(&self) -> Option<DateTime<Utc>> {
        self.active
            .as_ref()
            .map(|active| bounded_deadline(active.not_after, self.status.borrow().retain_until))
    }

    fn apply(&mut self, ctx: &X509Context) {
        let now = Utc::now();
        match SvidGeneration::select(ctx, &self.config, now) {
            Ok(generation) => match self.sink.activate(&generation) {
                Ok(number) => {
                    self.backoff.reset();
                    self.active = Some(Active {
                        not_after: generation.not_after,
                        bundles: generation.bundles.clone(),
                    });
                    self.update(|s| {
                        s.phase = SourcePhase::Streaming;
                        s.generation = Some(number);
                        s.not_after = Some(generation.not_after);
                        s.updated_at = Some(now);
                        s.outage_since = None;
                        s.retain_until = Some(generation.not_after);
                        s.last_error = None;
                        s.snapshots = s.snapshots.saturating_add(1);
                    });
                }
                Err(refused) => {
                    self.retain_or_withdraw(ctx, refused.code());
                }
            },
            Err(err) if err.is_withdrawal() => {
                let code = err.code().to_owned();
                self.withdraw(err.to_transport_error(), Some(&code));
            }
            Err(err) => {
                self.retain_or_withdraw(ctx, err.code());
            }
        }
    }

    fn retain_or_withdraw(&mut self, ctx: &X509Context, code: &str) {
        let safe_to_retain = self.active.as_ref().is_none_or(|active| {
            TrustDomainBundles::from_context(ctx)
                .is_ok_and(|incoming| incoming.contains_all(&active.bundles))
        });
        if safe_to_retain {
            self.update(|s| s.last_error = Some(code.to_owned()));
        } else {
            self.withdraw(TransportError::TrustUnknown, Some("trust_reduced"));
        }
    }

    fn on_outage(&mut self, err: &SpiffeSourceError) {
        let now = Utc::now();
        let max_stale = self.config.max_stale();
        let retain = self
            .active
            .as_ref()
            .map(|a| retention_deadline(a.not_after, Some((now, max_stale))));
        let code = err.code().to_owned();
        let phase = if retain.is_some() {
            SourcePhase::Outage
        } else {
            SourcePhase::Withdrawn
        };
        self.update(|s| apply_outage(s, now, retain, phase, code));
    }

    /// Sleep `delay`, withdrawing at `retain_until` if it passes first.
    /// Returns false when asked to stop.
    async fn retain_through(&mut self, delay: Duration) -> bool {
        let retain_until = self
            .status
            .borrow()
            .retain_until
            .filter(|_| self.active.is_some());
        let deadline = tokio::time::Instant::now() + delay;
        let expired = tokio::select! {
            biased;
            _ = self.stop.changed() => return false,
            () = sleep_until(retain_until) => true,
            () = tokio::time::sleep_until(deadline) => false,
        };
        if expired {
            self.withdraw(TransportError::EvidenceExpired, None);
            tokio::select! {
                _ = self.stop.changed() => return false,
                () = tokio::time::sleep_until(deadline) => {}
            }
        }
        !*self.stop.borrow()
    }

    /// Withdraw the active generation and publish the new status in **one**
    /// `send_modify`. `reported` is the fine-grained source reason when there
    /// is one (`svid_not_issued`, `bundle_missing`, …); otherwise the
    /// `TransportError` code stands in. Publishing the phase and the reason
    /// separately let an observer wake on `Withdrawn` while `last_error` still
    /// held the coarse code, which is what made the withdraw tests flaky.
    fn withdraw(&mut self, reason: TransportError, reported: Option<&str>) {
        let code = reported.map_or_else(|| reason.code().to_owned(), ToOwned::to_owned);
        if self.active.take().is_some() {
            self.sink.withdraw(reason);
        }
        self.update(|s| {
            if s.generation.is_some() && s.phase != SourcePhase::Withdrawn {
                s.withdrawals = s.withdrawals.saturating_add(1);
            }
            s.phase = SourcePhase::Withdrawn;
            s.retain_until = None;
            s.last_error = Some(code);
        });
    }

    fn update(&self, f: impl FnOnce(&mut SourceStatus)) {
        self.status.send_modify(f);
    }
}

fn apply_outage(
    s: &mut SourceStatus,
    now: DateTime<Utc>,
    retain: Option<DateTime<Utc>>,
    phase: SourcePhase,
    code: String,
) {
    s.last_error = Some(code);
    s.outage_since.get_or_insert(now);
    if matches!(s.phase, SourcePhase::Streaming | SourcePhase::Connecting) {
        s.phase = phase;
    }
    if let Some(r) = retain {
        s.retain_until = Some(s.retain_until.map_or(r, |cur| cur.min(r)));
    }
}

async fn wait_for_status(
    rx: &mut watch::Receiver<SourceStatus>,
    timeout: Duration,
    mut pred: impl FnMut(&SourceStatus) -> bool,
) -> Result<SourceStatus, WaitError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if pred(&rx.borrow()) {
            return Ok(rx.borrow().clone());
        }
        match tokio::time::timeout_at(deadline, rx.changed()).await {
            Ok(Ok(())) => {}
            Ok(Err(_)) => return Err(WaitError::StatusTaskGone(rx.borrow().clone())),
            Err(_) => return Err(WaitError::DeadlineElapsed(rx.borrow().clone())),
        }
    }
}

/// Sleep until `at`, or forever when `None`.
async fn sleep_until(at: Option<DateTime<Utc>>) {
    match at {
        Some(at) => {
            let remaining = (at - Utc::now()).to_std().unwrap_or(Duration::ZERO);
            tokio::time::sleep(remaining).await;
        }
        None => std::future::pending().await,
    }
}

#[cfg(test)]
#[path = "source_formal_tests.rs"]
mod formal_tests;

#[cfg(test)]
mod wait_tests {
    use std::time::Duration;

    use super::{wait_for_status, WaitError};
    use crate::status::SourceStatus;

    #[tokio::test]
    async fn wait_for_distinguishes_deadline_elapsed_from_status_task_gone() {
        let initial = SourceStatus::initial("spiffe://example.test/workload");
        let (tx, mut rx) = tokio::sync::watch::channel(initial);
        let deadline = wait_for_status(&mut rx, Duration::from_millis(30), |_| false)
            .await
            .expect_err("predicate never holds");
        assert!(matches!(deadline, WaitError::DeadlineElapsed(_)));

        drop(tx);
        let gone = wait_for_status(&mut rx, Duration::from_secs(5), |_| false)
            .await
            .expect_err("sender dropped");
        assert!(matches!(gone, WaitError::StatusTaskGone(_)));
        assert_ne!(
            std::mem::discriminant(&deadline),
            std::mem::discriminant(&gone)
        );
    }
}
