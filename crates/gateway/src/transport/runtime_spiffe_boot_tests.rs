//! SPIFFE listener bind gate at startup.
//!
//! `wait_for` can observe a generation and a later withdrawal as one status:
//! the source keeps `generation` set when it enters [`SourcePhase::Withdrawn`]
//! or [`SourcePhase::Stopped`]. That snapshot is [`TransportError::IdentityMissing`],
//! not a successful bind.

use opensesame_domain::TransportError;
use opensesame_spiffe_source::{SourcePhase, SourceStatus, WaitError};
use opensesame_time::{Duration, Utc};
use opensesame_transport_security::{GenerationCandidate, TransportGenerations};

use super::runtime::{
    conclude_spiffe_first_svid, spiffe_first_ready_to_bind, spiffe_first_svid_settled,
};

fn live_generations(number: u64) -> std::sync::Arc<TransportGenerations> {
    TransportGenerations::new(
        GenerationCandidate::default()
            .into_generation(number, Utc::now())
            .expect("fixture generation"),
    )
}

fn status_with(phase: SourcePhase, generation: Option<u64>) -> SourceStatus {
    let mut status = SourceStatus::initial("spiffe://example.test/opensesame/gateway");
    status.phase = phase;
    status.generation = generation;
    if generation.is_some() {
        status.not_after = Some(Utc::now() + Duration::hours(1));
    }
    status
}

#[test]
fn generation_observed_then_withdrawn_before_bind_is_identity_missing() {
    let streaming = status_with(SourcePhase::Streaming, Some(1));
    assert!(spiffe_first_ready_to_bind(&streaming));

    // Withdrawal lands before `wait_for` returns. The generation number stays.
    let withdrawn = status_with(SourcePhase::Withdrawn, streaming.generation);
    assert!(
        spiffe_first_svid_settled(&withdrawn),
        "withdrawal ends the first-SVID wait"
    );
    assert!(!spiffe_first_ready_to_bind(&withdrawn));
    let error = conclude_spiffe_first_svid(Ok(withdrawn), &live_generations(1))
        .expect_err("a withdrawn generation must not bind the listener");
    assert_eq!(error, TransportError::IdentityMissing);
}

#[test]
fn a_stopped_source_with_a_generation_is_identity_missing() {
    let stopped = status_with(SourcePhase::Stopped, Some(1));
    assert!(spiffe_first_svid_settled(&stopped));
    assert_eq!(
        conclude_spiffe_first_svid(Ok(stopped), &live_generations(1)).expect_err("stopped source must not bind"),
        TransportError::IdentityMissing
    );
}

#[test]
fn a_generation_at_its_effective_deadline_is_not_ready() {
    let boundary = Utc::now();

    let mut at_retention = status_with(SourcePhase::Streaming, Some(2));
    at_retention.retain_until = Some(boundary);
    at_retention.not_after = Some(boundary + Duration::hours(1));
    assert!(
        !spiffe_first_ready_to_bind(&at_retention),
        "retain_until equality must not bind"
    );
    assert_eq!(
        conclude_spiffe_first_svid(Ok(at_retention), &live_generations(2)).expect_err("retain_until equality"),
        TransportError::IdentityMissing
    );

    let mut at_certificate = status_with(SourcePhase::Streaming, Some(3));
    at_certificate.not_after = Some(boundary);
    at_certificate.retain_until = Some(boundary + Duration::hours(1));
    assert!(
        !spiffe_first_ready_to_bind(&at_certificate),
        "not_after equality must not bind"
    );
    assert_eq!(
        conclude_spiffe_first_svid(Ok(at_certificate), &live_generations(3)).expect_err("not_after equality"),
        TransportError::IdentityMissing
    );
}

#[test]
fn a_streaming_generation_may_bind() {
    let streaming = status_with(SourcePhase::Streaming, Some(1));
    assert!(spiffe_first_svid_settled(&streaming));
    assert!(conclude_spiffe_first_svid(Ok(streaming), &live_generations(1)).is_ok());
}

#[tokio::test]
async fn coalesced_watch_update_refuses_a_withdrawn_generation() {
    let (tx, rx) = tokio::sync::watch::channel(status_with(SourcePhase::Connecting, None));
    tx.send(status_with(SourcePhase::Streaming, Some(3)))
        .expect("status sender live");
    tx.send_modify(|status| {
        status.phase = SourcePhase::Withdrawn;
    });
    // `watch` keeps only the latest value, which is what `wait_for` borrows
    // when both updates land before it runs.
    let observed = rx.borrow().clone();
    assert_eq!(observed.generation, Some(3));
    assert_eq!(observed.phase, SourcePhase::Withdrawn);
    assert!(spiffe_first_svid_settled(&observed));
    assert_eq!(
        conclude_spiffe_first_svid(Ok(observed), &live_generations(1)).expect_err("coalesced withdrawal must not bind"),
        TransportError::IdentityMissing
    );
}

#[test]
fn prompt_withdrawal_before_any_generation_is_not_settled() {
    for phase in [SourcePhase::Withdrawn, SourcePhase::Stopped] {
        let status = status_with(phase, None);
        assert!(
            !spiffe_first_svid_settled(&status),
            "{phase:?} before any generation must keep the first-SVID wait open"
        );
    }
    let withdrawn = status_with(SourcePhase::Withdrawn, None);
    assert!(
        conclude_spiffe_first_svid(
        Err(WaitError::DeadlineElapsed(withdrawn)),
        &live_generations(1),
    ).is_err(),
        "wait should time out, not treat early withdrawal as settled"
    );
}

#[test]
fn a_deadline_with_no_generation_is_identity_missing() {
    let connecting = status_with(SourcePhase::Connecting, None);
    assert!(!spiffe_first_svid_settled(&connecting));
    assert_eq!(
        conclude_spiffe_first_svid(
        Err(WaitError::DeadlineElapsed(connecting)),
        &live_generations(1),
    )
            .expect_err("deadline refuses the bind"),
        TransportError::IdentityMissing
    );
}
