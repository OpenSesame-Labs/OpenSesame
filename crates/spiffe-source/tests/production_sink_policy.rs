//! End-to-end withdrawal through the production generation sink.

#[path = "support/policy.rs"]
mod policy;

use std::sync::Arc;
use std::time::Duration;

use opensesame_domain::{TransportError, TrustProfileKind};
use opensesame_spiffe_source::fake::{FakeTrustDomain, FakeWorkloadApi};
use opensesame_spiffe_source::sink::TransportGenerationsSink;
use opensesame_spiffe_source::SpiffeSource;
use opensesame_time::Utc;
use opensesame_transport_security::{GenerationCandidate, TransportGenerations};
use policy::{config, snapshot, streaming, withdrawn_promptly, GW, TD};

/// The production manager's current generation is the number `activate`
/// returned, serving `GW` under the snapshot's trust domain.
fn assert_live(generations: &TransportGenerations, number: u64) {
    let current = generations.current();
    assert_eq!(current.number, number);
    assert_eq!(current.withdrawn, None);
    let identity = current
        .identity
        .as_ref()
        .expect("production sink installed an identity");
    assert_eq!(identity.spiffe_id(), Some(GW));
    let bundle = current
        .peer_trust
        .iter()
        .find(|(profile, _)| profile.name == TD)
        .map(|(_, bundle)| bundle)
        .expect("production sink filed the trust-domain bundle");
    assert_eq!(bundle.kind(), TrustProfileKind::SpiffeTrustDomain);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn removed_identity_withdraws_the_production_generation_and_can_recover() {
    let initial = GenerationCandidate::default()
        .into_generation(0, Utc::now())
        .unwrap();
    let generations = TransportGenerations::new(initial);
    let sink = Arc::new(TransportGenerationsSink::new(generations.clone()));
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let gateway = td.issue_svid(GW, Duration::from_mins(10));
    api.push_snapshot(snapshot(&td, &[&gateway]));
    let handle = SpiffeSource::start(config(&api, Duration::from_secs(5)), sink);

    let live = streaming(&handle, 1).await;
    assert_eq!(live.generation, Some(1));
    assert_live(&generations, 1);

    api.revoke_all();
    let withdrawn = withdrawn_promptly(&handle).await;
    // `withdraw` allocates the next manager generation and keeps the SVID
    // marked withdrawn. Source status keeps the number `activate` returned,
    // so this is not the recording sink's "still generation 1, no bump".
    assert_eq!(withdrawn.generation, Some(1));
    assert_eq!(withdrawn.withdrawals, 1);
    let ended = generations.current();
    assert_eq!(ended.number, 2);
    assert_eq!(ended.withdrawn, Some(TransportError::IdentityMissing));
    assert_eq!(
        ended.identity.as_ref().and_then(|id| id.spiffe_id()),
        Some(GW)
    );

    api.push_snapshot(snapshot(&td, &[&gateway]));
    // Activate (1), withdraw (2), activate again (3). A recording sink does
    // not consume a number on withdraw, so the same revoke-and-restore
    // shape there settles at 2.
    let recovered = streaming(&handle, 3).await;
    assert_eq!(recovered.generation, Some(3));
    assert_eq!(recovered.withdrawals, 1);
    assert_live(&generations, 3);
    handle.stop().await;
}
