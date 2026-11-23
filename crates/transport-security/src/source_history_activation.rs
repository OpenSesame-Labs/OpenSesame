//! Owner-fenced source activation after an asynchronous history write.

use std::time::Instant;

use opensesame_domain::TransportError;
use opensesame_time::{DateTime, Utc};

use super::{monotonic_bound, Fence, GenerationCandidate, SourceOwner, TransportGenerations};

#[derive(Debug)]
pub(super) struct Pending {
    epoch: u64,
    wait_deadline: DateTime<Utc>,
    wait_monotonic: Instant,
    cert_deadline: DateTime<Utc>,
    cert_monotonic: Instant,
}

impl TransportGenerations {
    /// Publish a source candidate provisionally within the write-wait bound.
    /// Until owner-scoped finalization, every checked use enforces that bound.
    ///
    /// # Errors
    /// A stale owner/epoch, expired wait or certificate, invalid candidate,
    /// generation overflow, or poisoned manager lock.
    pub fn activate_from_source_before(
        &self,
        owner: &SourceOwner,
        expected_epoch: u64,
        candidate: GenerationCandidate,
        wait_deadline: DateTime<Utc>,
        wait_monotonic: Instant,
    ) -> Result<u64, TransportError> {
        self.activate_source_before_with_clock(
            owner,
            expected_epoch,
            candidate,
            wait_deadline,
            wait_monotonic,
            || {
                let monotonic = Instant::now();
                (Utc::now(), monotonic)
            },
        )
    }

    /// Test the actual serialized check at explicitly chosen clock values.
    ///
    /// # Errors
    /// As [`Self::activate_from_source_before`].
    #[cfg(any(test, feature = "testkit"))]
    pub fn activate_from_source_before_at(
        &self,
        owner: &SourceOwner,
        expected_epoch: u64,
        candidate: GenerationCandidate,
        wait_deadline: DateTime<Utc>,
        wait_monotonic: Instant,
        clock: (DateTime<Utc>, Instant),
    ) -> Result<u64, TransportError> {
        self.activate_source_before_with_clock(
            owner,
            expected_epoch,
            candidate,
            wait_deadline,
            wait_monotonic,
            || clock,
        )
    }

    fn activate_source_before_with_clock(
        &self,
        owner: &SourceOwner,
        expected_epoch: u64,
        candidate: GenerationCandidate,
        wait_deadline: DateTime<Utc>,
        wait_monotonic: Instant,
        clock: impl FnOnce() -> (DateTime<Utc>, Instant),
    ) -> Result<u64, TransportError> {
        let mut serial = self
            .activation
            .lock()
            .map_err(|_| TransportError::SourceUnsupported)?;
        if !owner.belongs_to(self) || !serial.matching(owner, expected_epoch) {
            return Err(TransportError::GenerationStale);
        }
        if candidate
            .peer_trust
            .iter()
            .any(|(key, bundle)| key != bundle.profile())
        {
            return Err(TransportError::GenerationStale);
        }
        let cert_deadline = candidate
            .identity
            .as_ref()
            .ok_or(TransportError::IdentityMissing)?
            .not_after();
        let trust = candidate.peer_trust.clone();
        let own_trust = candidate.own_trust.clone();
        let number = self
            .current
            .load()
            .number
            .checked_add(1)
            .ok_or(TransportError::SourceUnsupported)?;
        let next = candidate.into_generation(number, Utc::now())?;
        // Sample after waiting for the manager lock and after all candidate
        // validation, while source ownership cannot change underneath us.
        if !owner.belongs_to(self) || !serial.matching(owner, expected_epoch) {
            return Err(TransportError::GenerationStale);
        }
        let (now, monotonic) = clock();
        if now >= wait_deadline || monotonic >= wait_monotonic || now >= cert_deadline {
            return Err(TransportError::EvidenceExpired);
        }
        let cert_monotonic = monotonic_bound(cert_deadline, now, monotonic)?;
        serial.pending = Some(Pending {
            epoch: number,
            wait_deadline,
            wait_monotonic,
            cert_deadline,
            cert_monotonic,
        });
        self.current.store(std::sync::Arc::new(next));
        self.changes.send_replace(number);
        serial.source_profiles.extend(trust.keys().cloned());
        serial.fence = Some(Fence {
            owner: owner.clone(),
            epoch: number,
            deadline: Some(cert_deadline.min(wait_deadline)),
            monotonic_deadline: Some(cert_monotonic.min(wait_monotonic)),
            expired: false,
            trust,
            own_trust,
        });
        Ok(number)
    }

    /// Complete a provisional source publication only while the same owner,
    /// epoch and both wait bounds are still valid. An observed expiry or an
    /// independent tightening prevents extension to the certificate deadline.
    ///
    /// # Errors
    /// A stale owner/epoch, expired bound, changed fence, or poisoned lock.
    pub fn finalize_source_activation(
        &self,
        owner: &SourceOwner,
        epoch: u64,
    ) -> Result<(), TransportError> {
        let mut serial = self
            .activation
            .lock()
            .map_err(|_| TransportError::SourceUnsupported)?;
        if !owner.belongs_to(self) || !serial.matching(owner, epoch) {
            return Err(TransportError::GenerationStale);
        }
        if self.current.load().withdrawn.is_some() {
            return Err(TransportError::GenerationStale);
        }
        let pending = serial
            .pending
            .take()
            .ok_or(TransportError::GenerationStale)?;
        if pending.epoch != epoch {
            return Err(TransportError::GenerationStale);
        }
        let fence = serial
            .fence
            .as_mut()
            .ok_or(TransportError::GenerationStale)?;
        if fence.deadline != Some(pending.cert_deadline.min(pending.wait_deadline))
            || fence.monotonic_deadline != Some(pending.cert_monotonic.min(pending.wait_monotonic))
        {
            return Err(TransportError::GenerationStale);
        }
        let monotonic = Instant::now();
        let now = Utc::now();
        if fence.expired
            || now >= pending.wait_deadline
            || monotonic >= pending.wait_monotonic
            || now >= pending.cert_deadline
            || monotonic >= pending.cert_monotonic
        {
            return Err(TransportError::EvidenceExpired);
        }
        fence.deadline = Some(pending.cert_deadline);
        fence.monotonic_deadline = Some(pending.cert_monotonic);
        Ok(())
    }
}

#[cfg(all(test, feature = "testkit"))]
mod tests {
    use std::sync::{mpsc, Arc};
    use std::time::{Duration, Instant};

    use super::*;
    use crate::testkit::DisposableCa;

    #[test]
    fn a_paused_publication_keeps_the_wait_bound_until_owner_finalization() {
        let ca = DisposableCa::new("source-history-server");
        let candidate = GenerationCandidate {
            identity: Some(Arc::new(ca.issue_server("localhost").identity())),
            identity_required: true,
            ..GenerationCandidate::default()
        };
        let initial = candidate.clone().into_generation(1, Utc::now()).unwrap();
        let generations = TransportGenerations::new(initial);
        let owner = generations.source_owner();
        let epoch = generations.claim_source(&owner).unwrap();
        let wall_deadline = Utc::now() + opensesame_time::Duration::minutes(1);
        let mono_deadline = Instant::now() + Duration::from_mins(1);
        let (sampled_tx, sampled_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let writer_manager = Arc::clone(&generations);
        let writer_owner = owner.clone();
        let writer = std::thread::spawn(move || {
            writer_manager.activate_source_before_with_clock(
                &writer_owner,
                epoch,
                candidate,
                wall_deadline,
                mono_deadline,
                || {
                    let monotonic = Instant::now();
                    let now = Utc::now();
                    sampled_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    (now, monotonic)
                },
            )
        });
        sampled_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let reader_manager = Arc::clone(&generations);
        let (reader_tx, reader_rx) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            reader_tx
                .send(reader_manager.checked_current_at(None, wall_deadline))
                .unwrap();
        });
        assert!(reader_rx.recv_timeout(Duration::from_millis(50)).is_err());
        release_tx.send(()).unwrap();
        let published = writer.join().unwrap().unwrap();
        assert!(matches!(
            reader_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            Err(TransportError::EvidenceExpired)
        ));
        reader.join().unwrap();
        assert_eq!(
            generations.finalize_source_activation(&owner, published),
            Err(TransportError::EvidenceExpired)
        );
        assert!(generations.checked_current(None).is_err());
    }
}
