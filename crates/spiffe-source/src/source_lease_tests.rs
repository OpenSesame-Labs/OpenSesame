//! Real manager regressions for startup quarantine and task cancellation.

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use opensesame_domain::TransportError;
use opensesame_transport_security::{GenerationCandidate, TransportGenerations};
use secrecy::ExposeSecret as _;
use spiffe::{TrustDomain, X509Bundle, X509BundleSet, X509Context, X509Svid};

use super::{SourcePhase, SpiffeSource, SpiffeSourceHandle};
use crate::config::SpiffeSourceConfig;
use crate::fake::{FakeTrustDomain, FakeWorkloadApi, IssuedSvid};
use crate::sink::TransportGenerationsSink;
use crate::snapshot::SvidGeneration;

const ID: &str = "spiffe://example.test/opensesame/gateway";
const TD: &str = "example.test";

fn populated(
    config: &SpiffeSourceConfig,
    domain: &FakeTrustDomain,
    issued: &IssuedSvid,
) -> (Arc<TransportGenerations>, GenerationCandidate) {
    let svid = Arc::new(
        X509Svid::parse_from_der(
            &issued.chain_der.concat(),
            issued.key_pkcs8_der.expose_secret(),
        )
        .unwrap(),
    );
    let mut bundles = X509BundleSet::new();
    bundles.add_bundle(
        X509Bundle::parse_from_der(TrustDomain::new(TD).unwrap(), &domain.bundle_der()).unwrap(),
    );
    let context = X509Context::new([svid], bundles);
    let generation = SvidGeneration::select(&context, config, Utc::now()).unwrap();
    let candidate = TransportGenerationsSink::candidate(&generation).unwrap();
    let initial = candidate.clone().into_generation(1, Utc::now()).unwrap();
    (TransportGenerations::new(initial), candidate)
}

fn publish(api: &FakeWorkloadApi, domain: &FakeTrustDomain, issued: &IssuedSvid) {
    api.push_snapshot(FakeWorkloadApi::snapshot(
        vec![issued.to_proto(&domain.bundle_der(), "")],
        &[],
    ));
}

async fn wait_streaming(handle: &SpiffeSourceHandle) {
    handle
        .wait_for(Duration::from_secs(5), |status| {
            status.phase == SourcePhase::Streaming
        })
        .await
        .expect("valid snapshot activates");
}

fn assert_quarantined(gens: &TransportGenerations, previous: &GenerationCandidate) {
    assert!(gens.current().withdrawn.is_some());
    assert!(gens.checked_current(None).is_err());
    assert!(gens.activate(previous.clone()).is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn initial_denial_quarantines_a_populated_sink_then_valid_material_recovers() {
    let api = FakeWorkloadApi::start();
    let domain = FakeTrustDomain::new(TD);
    let issued = domain.issue_svid(ID, Duration::from_mins(10));
    let config = SpiffeSourceConfig::deployment_plane(ID, api.socket_path()).unwrap();
    let (gens, previous) = populated(&config, &domain, &issued);
    let sink = Arc::new(TransportGenerationsSink::new(Arc::clone(&gens)));
    let handle = SpiffeSource::start(config, sink).unwrap();
    assert_quarantined(&gens, &previous);
    handle
        .wait_for(Duration::from_secs(5), |status| {
            status.phase == SourcePhase::Withdrawn
        })
        .await
        .expect("initial denial is observed");
    assert_quarantined(&gens, &previous);
    publish(&api, &domain, &issued);
    wait_streaming(&handle).await;
    assert!(gens.checked_current(None).is_ok());
    handle.stop().await;
    assert_quarantined(&gens, &previous);
    api.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unavailable_socket_quarantines_a_populated_sink_before_connection() {
    let dir = tempfile::tempdir().unwrap();
    let config = SpiffeSourceConfig::deployment_plane(ID, dir.path().join("missing.sock")).unwrap();
    let domain = FakeTrustDomain::new(TD);
    let issued = domain.issue_svid(ID, Duration::from_mins(10));
    let (gens, previous) = populated(&config, &domain, &issued);
    let sink = Arc::new(TransportGenerationsSink::new(Arc::clone(&gens)));
    let handle = SpiffeSource::start(config, sink).unwrap();
    assert_quarantined(&gens, &previous);
    handle
        .wait_for(Duration::from_secs(5), |status| {
            status.phase == SourcePhase::Withdrawn
        })
        .await
        .expect("outage is observed");
    assert_quarantined(&gens, &previous);
    handle.stop().await;
    assert_quarantined(&gens, &previous);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stalled_initial_rpc_and_competing_source_cannot_restore_the_old_sink() {
    let api = FakeWorkloadApi::start();
    let domain = FakeTrustDomain::new(TD);
    let issued = domain.issue_svid(ID, Duration::from_mins(10));
    publish(&api, &domain, &issued);
    api.stall_on_reconnect();
    let config = SpiffeSourceConfig::deployment_plane(ID, api.socket_path()).unwrap();
    let (gens, previous) = populated(&config, &domain, &issued);
    let sink = Arc::new(TransportGenerationsSink::new(Arc::clone(&gens)));
    let handle = SpiffeSource::start(config.clone(), sink.clone()).unwrap();
    assert!(matches!(
        SpiffeSource::start(config, sink),
        Err(TransportError::GenerationStale)
    ));
    tokio::time::timeout(Duration::from_secs(5), async {
        while api.stalled_opens() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("RPC opening stalled");
    assert_quarantined(&gens, &previous);
    tokio::time::timeout(Duration::from_secs(5), handle.stop())
        .await
        .expect("stop interrupts the stalled opening");
    assert_quarantined(&gens, &previous);
    api.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn aborting_an_active_source_retires_only_its_lease() {
    let api = FakeWorkloadApi::start();
    let domain = FakeTrustDomain::new(TD);
    let issued = domain.issue_svid(ID, Duration::from_mins(10));
    publish(&api, &domain, &issued);
    let config = SpiffeSourceConfig::deployment_plane(ID, api.socket_path()).unwrap();
    let (gens, previous) = populated(&config, &domain, &issued);
    let sink = Arc::new(TransportGenerationsSink::new(Arc::clone(&gens)));
    let handle = SpiffeSource::start(config.clone(), sink.clone()).unwrap();
    wait_streaming(&handle).await;
    assert!(gens.checked_current(None).is_ok());
    handle.task.as_ref().unwrap().abort();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !handle.task.as_ref().unwrap().is_finished() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_quarantined(&gens, &previous);
    drop(handle);
    let next = SpiffeSource::start(config, sink).unwrap();
    wait_streaming(&next).await;
    assert!(gens.checked_current(None).is_ok());
    next.stop().await;
    api.shutdown().await;
}

#[tokio::test(flavor = "current_thread")]
async fn dropping_handle_quarantines_before_the_task_can_be_scheduled() {
    let api = FakeWorkloadApi::start();
    let domain = FakeTrustDomain::new(TD);
    let issued = domain.issue_svid(ID, Duration::from_mins(10));
    publish(&api, &domain, &issued);
    let config = SpiffeSourceConfig::deployment_plane(ID, api.socket_path()).unwrap();
    let (gens, previous) = populated(&config, &domain, &issued);
    let sink = Arc::new(TransportGenerationsSink::new(Arc::clone(&gens)));
    let handle = SpiffeSource::start(config.clone(), sink.clone()).unwrap();
    wait_streaming(&handle).await;
    assert!(gens.checked_current(None).is_ok());
    drop(handle);
    // No await/yield intervenes: the source task cannot have processed stop.
    assert_quarantined(&gens, &previous);
    let next = SpiffeSource::start(config, sink).unwrap();
    wait_streaming(&next).await;
    assert!(gens.checked_current(None).is_ok());
    next.stop().await;
    api.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_outage_publishes_the_use_time_bound_before_its_timer_expires() {
    let api = FakeWorkloadApi::start();
    let domain = FakeTrustDomain::new(TD);
    let issued = domain.issue_svid(ID, Duration::from_mins(10));
    publish(&api, &domain, &issued);
    let config = SpiffeSourceConfig::deployment_plane(ID, api.socket_path())
        .unwrap()
        .with_max_stale(Duration::from_secs(30));
    let (gens, _) = populated(&config, &domain, &issued);
    let sink = Arc::new(TransportGenerationsSink::new(Arc::clone(&gens)));
    let handle = SpiffeSource::start(config, sink).unwrap();
    wait_streaming(&handle).await;
    api.stall_on_reconnect();
    let status = handle
        .wait_for(Duration::from_secs(5), |status| {
            status.phase == SourcePhase::Outage
        })
        .await
        .expect("outage is observed");
    let deadline = status.retain_until.expect("bounded outage");
    assert!(
        gens.current().withdrawn.is_none(),
        "source timer has not fired"
    );
    assert!(matches!(
        gens.checked_current_at(None, deadline),
        Err(TransportError::EvidenceExpired)
    ));
    handle.stop().await;
    api.shutdown().await;
}
