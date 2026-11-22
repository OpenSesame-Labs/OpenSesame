//! Rejected candidates must not retain trust removed by a new snapshot.

#[path = "support/policy.rs"]
mod policy;

use std::time::Duration;

use opensesame_domain::TransportError;
use opensesame_spiffe_source::fake::{FakeTrustDomain, FakeWorkloadApi, IssuedSvid};
use opensesame_spiffe_source::sink::recording::{RecordingSink, SinkEvent};
use opensesame_spiffe_source::{SourcePhase, SpiffeSource};
use policy::{config, snapshot, streaming, withdrawn_promptly, GW, TD, WAIT};

fn federated_snapshot(
    td: &FakeTrustDomain,
    gateway: &IssuedSvid,
    foreign_bundle: Option<Vec<u8>>,
) -> opensesame_spiffe_source::fake::pb::X509svidResponse {
    if foreign_bundle.is_none() {
        return snapshot(td, &[gateway]);
    }
    let foreign = foreign_bundle.map_or_else(Vec::new, |der| vec![("partner.test", der)]);
    FakeWorkloadApi::snapshot(vec![gateway.to_proto(&td.bundle_der(), "")], &foreign)
}

async fn rejected_reduction_withdraws(profile_error: bool, remove_one_anchor: bool) {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let foreign_a = FakeTrustDomain::new("partner.test");
    let foreign_b = FakeTrustDomain::new("partner.test");
    let gateway = td.issue_svid(GW, Duration::from_mins(10));
    let initial_bundle = [foreign_a.bundle_der(), foreign_b.bundle_der()].concat();
    api.push_snapshot(federated_snapshot(&td, &gateway, Some(initial_bundle)));
    let sink = RecordingSink::shared();
    let handle = SpiffeSource::start(config(&api, Duration::from_secs(5)), sink.clone()).unwrap();
    streaming(&handle, 1).await;

    let rejected = if profile_error {
        let mut spec =
            opensesame_spiffe_source::fake::SvidSpec::conforming(GW, Duration::from_mins(10));
        spec.eku = opensesame_spiffe_source::fake::Eku::ServerOnly;
        td.issue(&spec)
    } else {
        sink.reject_activations(Some(TransportError::KeyPairMismatch));
        gateway
    };
    let next_bundle = remove_one_anchor.then(|| foreign_a.bundle_der());
    api.push_snapshot(federated_snapshot(&td, &rejected, next_bundle));
    let status = if profile_error {
        let status = withdrawn_promptly(&handle).await;
        assert_eq!(status.last_error.as_deref(), Some("trust_reduced"));
        status
    } else {
        handle
            .wait_for(WAIT, |status| {
                status.last_error.as_deref() == Some("key_pair_mismatch")
            })
            .await
            .expect("rejected activation is reported after withdrawal")
    };
    assert_eq!(status.phase, SourcePhase::Withdrawn);
    assert_eq!(
        sink.last(),
        Some(SinkEvent::Withdrawn(TransportError::TrustUnknown))
    );
    handle.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rejected_profile_with_omitted_domain_withdraws() {
    rejected_reduction_withdraws(true, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refused_activation_with_omitted_domain_withdraws() {
    rejected_reduction_withdraws(false, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rejected_profile_with_removed_anchor_withdraws() {
    rejected_reduction_withdraws(true, true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refused_activation_with_removed_anchor_withdraws() {
    rejected_reduction_withdraws(false, true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refused_profile_after_trust_reduction_keeps_withdrawal_reason() {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let foreign_a = FakeTrustDomain::new("partner.test");
    let foreign_b = FakeTrustDomain::new("partner.test");
    let gateway = td.issue_svid(GW, Duration::from_mins(10));
    let initial_bundle = [foreign_a.bundle_der(), foreign_b.bundle_der()].concat();
    api.push_snapshot(federated_snapshot(&td, &gateway, Some(initial_bundle)));
    let sink = RecordingSink::shared();
    let handle = SpiffeSource::start(config(&api, Duration::from_secs(5)), sink.clone()).unwrap();
    streaming(&handle, 1).await;

    // A refused activation on a reduced-trust snapshot withdraws with the
    // authoritative `trust_reduced` reason and retains nothing.
    sink.reject_activations(Some(TransportError::KeyPairMismatch));
    let reduced_bundle = foreign_a.bundle_der();
    api.push_snapshot(federated_snapshot(&td, &gateway, Some(reduced_bundle.clone())));
    let status = withdrawn_promptly(&handle).await;
    assert_eq!(status.last_error.as_deref(), Some("trust_reduced"));
    assert_eq!(
        sink.last(),
        Some(SinkEvent::Withdrawn(TransportError::TrustUnknown))
    );

    // A later profile-rejected candidate has no retained generation, so its
    // refusal code must not re-label the standing trust-reduction withdrawal.
    let mut spec =
        opensesame_spiffe_source::fake::SvidSpec::conforming(GW, Duration::from_mins(10));
    spec.eku = opensesame_spiffe_source::fake::Eku::ServerOnly;
    let rejected = td.issue(&spec);
    api.push_snapshot(federated_snapshot(&td, &rejected, Some(reduced_bundle)));
    let relabelled = handle
        .wait_for(Duration::from_secs(3), |s| {
            s.last_error.as_deref() == Some("svid_profile")
        })
        .await;
    assert!(
        relabelled.is_err(),
        "refusal code must not re-label a trust-reduced withdrawal"
    );
    let status = handle
        .wait_for(WAIT, |s| s.last_error.as_deref() == Some("trust_reduced"))
        .await
        .expect("trust_reduced still stands");
    assert_eq!(status.phase, SourcePhase::Withdrawn);
    handle.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rejected_profile_with_added_trust_retains_the_previous_generation() {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let foreign_a = FakeTrustDomain::new("partner.test");
    let foreign_b = FakeTrustDomain::new("partner.test");
    let gateway = td.issue_svid(GW, Duration::from_mins(10));
    api.push_snapshot(federated_snapshot(
        &td,
        &gateway,
        Some(foreign_a.bundle_der()),
    ));
    let sink = RecordingSink::shared();
    let handle = SpiffeSource::start(config(&api, Duration::from_secs(5)), sink.clone()).unwrap();
    streaming(&handle, 1).await;

    let mut spec =
        opensesame_spiffe_source::fake::SvidSpec::conforming(GW, Duration::from_mins(10));
    spec.eku = opensesame_spiffe_source::fake::Eku::ServerOnly;
    let rejected = td.issue(&spec);
    let expanded_bundle = [foreign_a.bundle_der(), foreign_b.bundle_der()].concat();
    api.push_snapshot(federated_snapshot(&td, &rejected, Some(expanded_bundle)));
    let status = handle
        .wait_for(WAIT, |s| s.last_error.as_deref() == Some("svid_profile"))
        .await
        .unwrap();
    assert_eq!(status.phase, SourcePhase::Streaming);
    assert_eq!(status.generation, Some(1));
    assert!(!sink
        .events()
        .iter()
        .any(|event| matches!(event, SinkEvent::Withdrawn(_))));
    handle.stop().await;
}
