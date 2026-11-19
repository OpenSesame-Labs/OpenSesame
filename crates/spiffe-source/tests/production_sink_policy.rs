//! End-to-end withdrawal through the production generation sink.

#[path = "support/policy.rs"]
mod policy;

use std::sync::Arc;
use std::time::Duration;

use opensesame_time::Utc;
use opensesame_domain::TransportError;
use opensesame_spiffe_source::fake::{FakeTrustDomain, FakeWorkloadApi};
use opensesame_spiffe_source::sink::TransportGenerationsSink;
use opensesame_spiffe_source::SpiffeSource;
use opensesame_transport_security::{GenerationCandidate, TransportGenerations};
use policy::{config, snapshot, streaming, withdrawn_promptly, GW, TD};

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
    let handle = SpiffeSource::start(config(&api, Duration::from_secs(5)), sink).unwrap();

    streaming(&handle, 2).await;
    assert!(generations.current().identity.is_some());
    assert_eq!(generations.current().withdrawn, None);

    api.revoke_all();
    withdrawn_promptly(&handle).await;
    assert_eq!(
        generations.current().withdrawn,
        Some(TransportError::IdentityMissing)
    );

    api.push_snapshot(snapshot(&td, &[&gateway]));
    streaming(&handle, 4).await;
    assert!(generations.current().identity.is_some());
    assert_eq!(generations.current().withdrawn, None);
    handle.stop().await;
}
