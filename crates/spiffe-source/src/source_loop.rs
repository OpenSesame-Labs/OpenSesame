//! The connection loop: stream snapshots from the Workload API, reduce each
//! to a generation, prepare and persist its trust history, activate or
//! withdraw, and bound what survives an outage.
//!
//! Snapshot semantics: every message **replaces** the prior state. A message
//! without the configured SVID, or without its trust domain's bundle, is an
//! authoritative withdrawal and is applied at once. An unparseable snapshot
//! also withdraws because the SDK cannot tell us whether it omitted the
//! configured identity or trust. A parsed candidate rejected by the profile or
//! sink retains the previous generation only when every old anchor is present
//! in the new trust view, and only within its existing time bounds. Explicit
//! permission or authentication denial is `ApiAction::Denied`; the loop maps
//! that to immediate generation withdrawal with `TransportError::IdentityMissing`
//! and the denial's status code. An empty Workload API response is the same
//! `ApiAction::Withdraw` as an empty SVID list. A transport error or
//! disconnect starts an outage: material is retained until the earlier of its
//! expiry or the outage freshness limit. Reconnection uses bounded, jittered
//! backoff; there is no fallback identity.

use std::time::Duration;

use futures::StreamExt as _;
use opensesame_domain::TransportError;
use opensesame_time::{DateTime, Utc};
use spiffe::transport::Endpoint;
use spiffe::{WorkloadApiClient, X509Context};
use tokio::sync::watch;

use super::source_policy::{classify_api_failure, ApiAction};
use crate::config::SpiffeSourceConfig;
use crate::error::SpiffeSourceError;
use crate::outage::{bounded_deadline, retention_deadline, Backoff};
use crate::sink::ClaimedSink;
use crate::snapshot::TrustDomainBundles;
use crate::status::{SourcePhase, SourceStatus};

#[path = "source_history_flow.rs"]
mod source_history_flow;
use source_history_flow::{
    sleep_until_monotonic, wait_for_history, Completion, PendingSnapshot, Preparation,
};

pub(super) struct Loop {
    config: SpiffeSourceConfig,
    sink: ClaimedSink,
    status: watch::Sender<SourceStatus>,
    stop: watch::Receiver<bool>,
    backoff: Backoff,
    active: Option<Active>,
}

/// The generation currently handed to the sink.
pub(super) struct Active {
    pub(super) not_after: DateTime<Utc>,
    pub(super) bundles: TrustDomainBundles,
    pub(super) monotonic_deadline: std::time::Instant,
}

enum StreamEnd {
    Stop,
    HistoryRetry,
    Broken(SpiffeSourceError),
    Withdrawn(TransportError, &'static str),
    Expired,
}

impl Loop {
    pub(super) fn new(
        config: SpiffeSourceConfig,
        sink: ClaimedSink,
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

    pub(super) async fn run(mut self) {
        loop {
            if *self.stop.borrow() {
                break;
            }
            match self.connect_and_stream().await {
                StreamEnd::Stop => break,
                StreamEnd::HistoryRetry => {}
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
        let mut pending: Option<Box<PendingSnapshot>> = None;
        loop {
            let expiry = self.active_deadline();
            let write_expiry = pending.as_ref().map(|snapshot| snapshot.wait_until);
            tokio::select! {
                biased;
                _ = self.stop.changed() => return StreamEnd::Stop,
                () = sleep_until(expiry) => {
                    let had_pending = pending.take().is_some();
                    self.withdraw(
                        TransportError::EvidenceExpired,
                        had_pending.then_some("history_write_timeout"),
                    );
                    if had_pending {
                        return StreamEnd::HistoryRetry;
                    }
                }
                () = sleep_until_monotonic(write_expiry) => {
                    drop(pending.take());
                    self.withdraw(TransportError::EvidenceExpired, Some("history_write_timeout"));
                    return StreamEnd::HistoryRetry;
                }
                item = stream.next() => {
                    // Any observed newer event supersedes the candidate. A
                    // detached old DB operation may reserve extra names but
                    // can no longer activate its snapshot.
                    drop(pending.take());
                    match item {
                        Some(Ok(ctx)) => match self.prepare_snapshot(&ctx) {
                            Preparation::Candidate(snapshot) => pending = Some(snapshot),
                            Preparation::Ignore => {}
                            Preparation::Retry => return StreamEnd::HistoryRetry,
                        },
                        Some(Err(error)) => return Self::end_action(classify_api_failure(&error), "stream"),
                        None => return StreamEnd::Broken(SpiffeSourceError::Transport("closed".into())),
                    }
                }
                result = wait_for_history(&mut pending) => {
                    if let Some(completed) = pending.take() {
                        if matches!(
                            self.finish_snapshot(&completed, result.is_ok()),
                            Completion::Retry
                        ) {
                            return StreamEnd::HistoryRetry;
                        }
                    } else {
                        self.withdraw(TransportError::SourceUnsupported, Some("history_state_invalid"));
                        return StreamEnd::Withdrawn(TransportError::SourceUnsupported, "history_state_invalid");
                    }
                }
            }
        }
    }

    /// Stream-open and mid-stream failures share this exit. `Denied` and
    /// `Withdraw` both end the stream there as generation withdrawal, so a
    /// following EOF cannot replace the reported reason with an outage.
    /// `Denied` uses `TransportError::IdentityMissing` and the denial's
    /// status code; `Withdraw` keeps its own reason and code.
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

    pub(super) fn retain_or_withdraw(&mut self, ctx: &X509Context, code: &str) {
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
        let monotonic_now = std::time::Instant::now();
        let now = Utc::now();
        let max_stale = self.config.max_stale();
        let retain = self
            .active
            .as_ref()
            .map(|a| retention_deadline(a.not_after, Some((now, max_stale))));
        if let Some(deadline) = retain {
            let Some(bound) = monotonic_now.checked_add(max_stale) else {
                self.withdraw(
                    TransportError::SourceUnsupported,
                    Some("source_ownership_lost"),
                );
                return;
            };
            if self.sink.0.tighten(deadline, bound).is_err() {
                self.withdraw(
                    TransportError::SourceUnsupported,
                    Some("source_ownership_lost"),
                );
                return;
            }
            if let Some(active) = self.active.as_mut() {
                active.monotonic_deadline = active.monotonic_deadline.min(bound);
            }
        }
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
            let _ = self.sink.0.withdraw(reason);
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

pub(super) fn apply_outage(
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
