//! Write-ahead ordering and cancellation against the real source and manager.
#[path = "support/policy.rs"]
mod policy;

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use opensesame_time::Utc;
use opensesame_domain::{TransportError, TrustProfileKind, TrustProfileRef};
use opensesame_spiffe_source::fake::{FakeTrustDomain, FakeWorkloadApi, IssuedSvid};
use opensesame_spiffe_source::sink::{GenerationHistory, HistoryWrite, TransportGenerationsSink};
use opensesame_spiffe_source::{SourcePhase, SpiffeSource};
use opensesame_transport_security::{GenerationCandidate, TransportGenerations, TrustBundle};
use policy::{config, snapshot, streaming, withdrawn_promptly, GW, TD};
use rustls_pki_types::CertificateDer;
use tokio::sync::{mpsc, Semaphore};

struct HeldHistory {
    blocked_call: usize,
    block_after: bool,
    calls: AtomicUsize,
    waiting: mpsc::UnboundedSender<BTreeSet<TrustProfileRef>>,
    release: Arc<Semaphore>,
}

impl GenerationHistory for HeldHistory {
    fn reserve(&self, names: BTreeSet<TrustProfileRef>) -> Result<HistoryWrite, TransportError> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        let blocked = if self.block_after {
            call >= self.blocked_call
        } else {
            call == self.blocked_call
        };
        if !blocked {
            return Ok(Box::pin(async { Ok(()) }));
        }
        self.waiting.send(names).unwrap();
        let release = Arc::clone(&self.release);
        Ok(Box::pin(async move {
            release.acquire_owned().await.unwrap().forget();
            Ok(())
        }))
    }
}

fn sink(
    blocked_call: usize,
) -> (
    Arc<TransportGenerations>,
    Arc<TransportGenerationsSink>,
    mpsc::UnboundedReceiver<BTreeSet<TrustProfileRef>>,
    Arc<Semaphore>,
) {
    sink_with_policy(blocked_call, false)
}

fn sink_with_policy(
    blocked_call: usize,
    block_after: bool,
) -> (
    Arc<TransportGenerations>,
    Arc<TransportGenerationsSink>,
    mpsc::UnboundedReceiver<BTreeSet<TrustProfileRef>>,
    Arc<Semaphore>,
) {
    let initial = GenerationCandidate::default()
        .into_generation(0, Utc::now())
        .unwrap();
    let generations = TransportGenerations::new(initial);
    let (waiting, events) = mpsc::unbounded_channel();
    let release = Arc::new(Semaphore::new(0));
    let history = Arc::new(HeldHistory {
        blocked_call,
        block_after,
        calls: AtomicUsize::new(0),
        waiting,
        release: Arc::clone(&release),
    });
    let sink = Arc::new(TransportGenerationsSink::with_history(
        Arc::clone(&generations),
        history,
    ));
    (generations, sink, events, release)
}

async fn waiting(
    events: &mut mpsc::UnboundedReceiver<BTreeSet<TrustProfileRef>>,
) -> BTreeSet<TrustProfileRef> {
    tokio::time::timeout(Duration::from_secs(5), events.recv())
        .await
        .expect("history write was not reached")
        .expect("history channel closed")
}

fn federated(
    td: &FakeTrustDomain,
    gateway: &IssuedSvid,
    other: &FakeTrustDomain,
) -> opensesame_spiffe_source::fake::pb::X509svidResponse {
    FakeWorkloadApi::snapshot(
        vec![gateway.to_proto(&td.bundle_der(), "")],
        &[("partner.test", other.bundle_der())],
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn initial_source_is_not_published_before_history_acknowledges() {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let gateway = td.issue_svid(GW, Duration::from_mins(10));
    api.push_snapshot(snapshot(&td, &[&gateway]));
    let (generations, sink, mut events, release) = sink(0);
    let handle = SpiffeSource::start(config(&api, Duration::from_secs(5)), sink).unwrap();
    let names = waiting(&mut events).await;
    assert_eq!(names, BTreeSet::from([TrustProfileRef::new(TD).unwrap()]));
    assert!(generations.checked_current(None).is_err());
    release.add_permits(1);
    streaming(&handle, 2).await;
    assert!(generations.checked_current(None).is_ok());
    handle.stop().await;
    api.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reduced_snapshot_withdraws_before_history_wait_and_stop_remains_prompt() {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let other = FakeTrustDomain::new("partner.test");
    let gateway = td.issue_svid(GW, Duration::from_mins(10));
    api.push_snapshot(federated(&td, &gateway, &other));
    let (generations, sink, mut events, release) = sink(1);
    let handle = SpiffeSource::start(config(&api, Duration::from_secs(5)), sink).unwrap();
    streaming(&handle, 2).await;
    api.push_snapshot(snapshot(&td, &[&gateway]));
    let incoming = waiting(&mut events).await;
    assert!(!incoming.contains(&TrustProfileRef::new("partner.test").unwrap()));
    assert!(generations.checked_current(None).is_err());
    assert_eq!(
        withdrawn_promptly(&handle).await.phase,
        SourcePhase::Withdrawn
    );
    tokio::time::timeout(Duration::from_secs(2), handle.stop())
        .await
        .expect("stop must not wait for storage");
    release.add_permits(1);
    assert!(generations.checked_current(None).is_err());
    api.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn additive_wait_keeps_old_trust_only_until_its_observed_bound() {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let other = FakeTrustDomain::new("partner.test");
    let gateway = td.issue_svid(GW, Duration::from_mins(10));
    api.push_snapshot(snapshot(&td, &[&gateway]));
    let (generations, sink, mut events, release) = sink_with_policy(1, true);
    let handle = SpiffeSource::start(config(&api, Duration::from_millis(500)), sink).unwrap();
    streaming(&handle, 2).await;
    api.push_snapshot(federated(&td, &gateway, &other));
    waiting(&mut events).await;
    assert!(generations.checked_current(None).is_ok());
    let status = handle
        .wait_for(Duration::from_secs(3), |status| {
            status.last_error.as_deref() == Some("history_write_timeout")
        })
        .await
        .expect("stalled write must time out");
    assert_eq!(status.phase, SourcePhase::Withdrawn);
    assert!(generations.checked_current(None).is_err());
    handle.stop().await;
    release.add_permits(1);
    assert!(generations.checked_current(None).is_err());
    api.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn zero_staleness_withdraws_the_old_generation_but_can_publish_a_fresh_one() {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let gateway = td.issue_svid(GW, Duration::from_mins(10));
    api.push_snapshot(snapshot(&td, &[&gateway]));
    let (generations, sink, mut events, release) = sink(1);
    let handle = SpiffeSource::start(config(&api, Duration::ZERO), sink).unwrap();
    streaming(&handle, 2).await;
    assert!(generations.checked_current(None).is_ok());
    api.push_snapshot(snapshot(&td, &[&gateway]));
    waiting(&mut events).await;
    assert!(generations.checked_current(None).is_err());
    assert_eq!(
        withdrawn_promptly(&handle).await.last_error.as_deref(),
        Some("history_write_pending")
    );
    release.add_permits(1);
    streaming(&handle, 4).await;
    assert!(generations.checked_current(None).is_ok());
    handle.stop().await;
    api.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_old_owner_during_a_write_cannot_replace_its_successor() {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let other = FakeTrustDomain::new("partner.test");
    let gateway = td.issue_svid(GW, Duration::from_mins(10));
    api.push_snapshot(snapshot(&td, &[&gateway]));
    let (generations, sink, mut events, release) = sink(1);
    let config = config(&api, Duration::from_secs(5));
    let old = SpiffeSource::start(config.clone(), sink.clone()).unwrap();
    streaming(&old, 2).await;
    api.push_snapshot(federated(&td, &gateway, &other));
    waiting(&mut events).await;
    drop(old);
    assert!(generations.checked_current(None).is_err());

    let successor = SpiffeSource::start(config, sink).unwrap();
    let status = successor
        .wait_for(Duration::from_secs(5), |status| {
            status.phase == SourcePhase::Streaming && status.generation.is_some_and(|n| n > 2)
        })
        .await
        .expect("successor accepts the current source snapshot");
    let successor_generation = status.generation.unwrap();
    release.add_permits(1);
    tokio::task::yield_now().await;
    assert!(generations
        .checked_current(Some(successor_generation))
        .is_ok());
    successor.stop().await;
    api.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn incoming_source_name_withdraws_a_colliding_local_bundle_before_the_write() {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let other = FakeTrustDomain::new("partner.test");
    let gateway = td.issue_svid(GW, Duration::from_mins(10));
    api.push_snapshot(snapshot(&td, &[&gateway]));
    let (generations, sink, mut events, release) = sink(1);
    let handle = SpiffeSource::start(config(&api, Duration::from_secs(5)), sink).unwrap();
    streaming(&handle, 2).await;
    let current = generations.current();
    let name = TrustProfileRef::new("partner.test").unwrap();
    let mut local = GenerationCandidate {
        identity: current.identity.clone(),
        peer_trust: current.peer_trust.clone(),
        own_trust: None,
        identity_required: true,
    };
    local.peer_trust.insert(
        name.clone(),
        TrustBundle::from_der(
            name.clone(),
            TrustProfileKind::PrivateRoot,
            vec![CertificateDer::from(other.bundle_der())],
        )
        .unwrap(),
    );
    generations.activate(local).unwrap();
    assert!(generations.checked_current(None).is_ok());
    api.push_snapshot(federated(&td, &gateway, &other));
    assert!(waiting(&mut events).await.contains(&name));
    assert!(generations.checked_current(None).is_err());
    assert_eq!(
        withdrawn_promptly(&handle).await.last_error.as_deref(),
        Some("source_name_reserved")
    );
    release.add_permits(1);
    handle
        .wait_for(Duration::from_secs(5), |status| {
            status.phase == SourcePhase::Streaming && status.generation.is_some_and(|n| n > 3)
        })
        .await
        .unwrap();
    assert!(generations.checked_current(None).is_ok());
    handle.stop().await;
    api.shutdown().await;
}
