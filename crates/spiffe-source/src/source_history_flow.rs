//! Prepare, persist and activate one source snapshot without holding the
//! synchronous source lease across the storage await.

use std::time::{Duration, Instant};

use opensesame_time::{DateTime, Utc};
use opensesame_domain::TransportError;
use spiffe::X509Context;

use super::{Active, Loop};
use crate::outage::{bounded_deadline, retention_deadline};
use crate::sink::{HistoryWrite, PreparationError};
use crate::snapshot::SvidGeneration;
use crate::status::SourcePhase;

// A history write must not retain an unprocessed snapshot indefinitely, even
// when there is no earlier generation to which max_stale can apply.
const MAX_HISTORY_WRITE_WAIT: Duration = Duration::from_secs(30);

pub(super) struct PendingSnapshot {
    generation: SvidGeneration,
    pub(super) write: HistoryWrite,
    pub(super) wait_until: Instant,
    wall_until: DateTime<Utc>,
}

pub(super) enum Preparation {
    Candidate(Box<PendingSnapshot>),
    Ignore,
    Retry,
}

pub(super) enum Completion {
    Continue,
    Retry,
}

pub(super) async fn sleep_until_monotonic(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(tokio::time::Instant::from_std(at)).await,
        None => std::future::pending().await,
    }
}

pub(super) async fn wait_for_history(
    pending: &mut Option<Box<PendingSnapshot>>,
) -> Result<(), TransportError> {
    match pending {
        Some(snapshot) => snapshot.write.as_mut().await,
        None => std::future::pending().await,
    }
}

impl Loop {
    /// Prepare synchronously; the stream loop polls the returned write while
    /// continuing to observe newer Workload API events.
    pub(super) fn prepare_snapshot(&mut self, ctx: &X509Context) -> Preparation {
        let observed_mono = Instant::now();
        let observed = Utc::now();
        let generation = match SvidGeneration::select(ctx, &self.config, observed) {
            Ok(generation) => generation,
            Err(err) if err.is_withdrawal() => {
                let code = err.code().to_owned();
                self.withdraw(err.to_transport_error(), Some(&code));
                return Preparation::Ignore;
            }
            Err(err) => {
                self.retain_or_withdraw(ctx, err.code());
                return Preparation::Ignore;
            }
        };
        // A reduced trust view is authoritative before storage can block.
        if self
            .active
            .as_ref()
            .is_some_and(|active| !generation.bundles.contains_all(&active.bundles))
        {
            self.withdraw(TransportError::TrustUnknown, Some("trust_reduced"));
        }
        // Zero max-stale means the previous generation may not survive a
        // storage wait, not that a fresh candidate can never be persisted.
        if self.config.max_stale().is_zero() && self.active.is_some() {
            self.withdraw(
                TransportError::EvidenceExpired,
                Some("history_write_pending"),
            );
        }

        let Some(mut wait_until) = observed_mono.checked_add(MAX_HISTORY_WRITE_WAIT) else {
            self.withdraw(
                TransportError::SourceUnsupported,
                Some("history_bound_invalid"),
            );
            return Preparation::Retry;
        };
        let mut wall_until = retention_deadline(
            generation.not_after,
            Some((observed, MAX_HISTORY_WRITE_WAIT)),
        );
        if let Some(active) = &self.active {
            let Some(stale_until) = observed_mono.checked_add(self.config.max_stale()) else {
                self.withdraw(
                    TransportError::SourceUnsupported,
                    Some("history_bound_invalid"),
                );
                return Preparation::Retry;
            };
            wait_until = wait_until.min(active.monotonic_deadline).min(stale_until);
            wall_until = wall_until.min(bounded_deadline(
                active.not_after,
                self.status.borrow().retain_until,
            ));
            wall_until = wall_until.min(retention_deadline(
                active.not_after,
                Some((observed, self.config.max_stale())),
            ));
            if self.sink.0.tighten(wall_until, wait_until).is_err() {
                self.withdraw(
                    TransportError::SourceUnsupported,
                    Some("source_ownership_lost"),
                );
                return Preparation::Retry;
            }
            if let Some(active) = &mut self.active {
                active.monotonic_deadline = wait_until;
            }
            self.update(|status| status.retain_until = Some(wall_until));
        }
        let prepared = match self.sink.0.prepare(&generation) {
            Ok(prepared) => prepared,
            Err(PreparationError::Lease(_)) => {
                self.withdraw(
                    TransportError::SourceUnsupported,
                    Some("source_ownership_lost"),
                );
                return Preparation::Retry;
            }
            Err(PreparationError::History(_)) => {
                self.withdraw(
                    TransportError::SourceUnsupported,
                    Some("history_unavailable"),
                );
                return Preparation::Retry;
            }
            Err(PreparationError::Candidate(error)) => {
                self.retain_or_withdraw(ctx, error.code());
                return Preparation::Ignore;
            }
        };
        if prepared.withdrew_local_conflict {
            self.withdraw(TransportError::TrustUnknown, Some("source_name_reserved"));
        }
        Preparation::Candidate(Box::new(PendingSnapshot {
            generation,
            write: prepared.write,
            wait_until,
            wall_until,
        }))
    }

    pub(super) fn finish_snapshot(
        &mut self,
        pending: &PendingSnapshot,
        write_succeeded: bool,
    ) -> Completion {
        let generation = &pending.generation;
        let wait_until = pending.wait_until;
        let wall_until = pending.wall_until;
        if Instant::now() >= wait_until || Utc::now() >= wall_until {
            self.withdraw(
                TransportError::EvidenceExpired,
                Some("history_write_timeout"),
            );
            return Completion::Retry;
        }
        if !write_succeeded {
            self.withdraw(
                TransportError::SourceUnsupported,
                Some("history_unavailable"),
            );
            return Completion::Retry;
        }
        // This call checks the owner and epoch again and revalidates the
        // candidate under the manager's activation lock.
        match self.sink.0.activate(generation, wall_until, wait_until) {
            Ok(number) => {
                let mono = Instant::now();
                let now = Utc::now();
                if mono >= wait_until || now >= wall_until {
                    // The swap may have taken time to validate. Withdraw the
                    // just-accepted epoch even when there was no prior active
                    // snapshot (and therefore no `Active` entry to retire).
                    let _ = self.sink.0.withdraw(TransportError::EvidenceExpired);
                    self.withdraw(
                        TransportError::EvidenceExpired,
                        Some("history_write_timeout"),
                    );
                    return Completion::Retry;
                }
                let Some(deadline) =
                    mono.checked_add((generation.not_after - now).to_std().unwrap_or_default())
                else {
                    let _ = self.sink.0.withdraw(TransportError::EvidenceExpired);
                    self.withdraw(
                        TransportError::EvidenceExpired,
                        Some("source_deadline_invalid"),
                    );
                    return Completion::Retry;
                };
                self.backoff.reset();
                self.active = Some(Active {
                    not_after: generation.not_after,
                    bundles: generation.bundles.clone(),
                    monotonic_deadline: deadline,
                });
                self.update(|status| {
                    status.phase = SourcePhase::Streaming;
                    status.generation = Some(number);
                    status.not_after = Some(generation.not_after);
                    status.updated_at = Some(now);
                    status.outage_since = None;
                    status.retain_until = Some(generation.not_after);
                    status.last_error = None;
                    status.snapshots = status.snapshots.saturating_add(1);
                });
            }
            Err(TransportError::GenerationStale | TransportError::SourceUnsupported) => {
                self.withdraw(
                    TransportError::SourceUnsupported,
                    Some("source_ownership_lost"),
                );
                return Completion::Retry;
            }
            Err(TransportError::EvidenceExpired) => {
                let _ = self.sink.0.withdraw(TransportError::EvidenceExpired);
                self.withdraw(
                    TransportError::EvidenceExpired,
                    Some("history_write_timeout"),
                );
                return Completion::Retry;
            }
            Err(error) => self.retain_candidate_or_withdraw(generation, error.code()),
        }
        Completion::Continue
    }

    fn retain_candidate_or_withdraw(&mut self, generation: &SvidGeneration, code: &str) {
        let safe = self
            .active
            .as_ref()
            .is_none_or(|active| generation.bundles.contains_all(&active.bundles));
        if safe {
            self.update(|status| status.last_error = Some(code.to_owned()));
        } else {
            self.withdraw(TransportError::TrustUnknown, Some("trust_reduced"));
        }
    }
}
