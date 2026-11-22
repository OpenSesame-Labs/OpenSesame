//! Observed Workload API events supersede pending write-ahead activations.
#[path = "support/policy.rs"]
mod policy;

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use opensesame_time::Utc;
use opensesame_domain::{TransportError, TrustProfileRef};
use opensesame_spiffe_source::fake::{FakeTrustDomain, FakeWorkloadApi, IssuedSvid};
use opensesame_spiffe_source::sink::{GenerationHistory, HistoryWrite, TransportGenerationsSink};
use opensesame_spiffe_source::SpiffeSource;
use opensesame_transport_security::{GenerationCandidate, TransportGenerations};
use policy::{config, snapshot, streaming, withdrawn_promptly, GW, TD};
use tokio::sync::{mpsc, Semaphore};

struct DetachedHistory {
    calls: AtomicUsize,
    entered: mpsc::UnboundedSender<usize>,
    completed: mpsc::UnboundedSender<usize>,
    gates: [Arc<Semaphore>; 2],
}

impl GenerationHistory for DetachedHistory {
    fn reserve(&self, _names: BTreeSet<TrustProfileRef>) -> Result<HistoryWrite, TransportError> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        if call == 0 {
            return Ok(Box::pin(async { Ok(()) }));
        }
        let gate = self
            .gates
            .get(call - 1)
            .cloned()
            .ok_or(TransportError::SourceUnsupported)?;
        self.entered.send(call).unwrap();
        let completed = self.completed.clone();
        let worker = tokio::spawn(async move {
            gate.acquire_owned().await.unwrap().forget();
            let _ = completed.send(call);
            Ok(())
        });
        Ok(Box::pin(async move {
            worker
                .await
                .map_err(|_| TransportError::SourceUnsupported)?
        }))
    }
}

struct ControlledSink {
    generations: Arc<TransportGenerations>,
    sink: Arc<TransportGenerationsSink>,
    entered: mpsc::UnboundedReceiver<usize>,
    completed: mpsc::UnboundedReceiver<usize>,
    gates: [Arc<Semaphore>; 2],
}

fn controlled_sink() -> ControlledSink {
    let initial = GenerationCandidate::default()
        .into_generation(0, Utc::now())
        .unwrap();
    let generations = TransportGenerations::new(initial);
    let (entered, entered_rx) = mpsc::unbounded_channel();
    let (completed, completed_rx) = mpsc::unbounded_channel();
    let gates = [Arc::new(Semaphore::new(0)), Arc::new(Semaphore::new(0))];
    let history = Arc::new(DetachedHistory {
        calls: AtomicUsize::new(0),
        entered,
        completed,
        gates: gates.clone(),
    });
    let sink = Arc::new(TransportGenerationsSink::with_history(
        Arc::clone(&generations),
        history,
    ));
    ControlledSink {
        generations,
        sink,
        entered: entered_rx,
        completed: completed_rx,
        gates,
    }
}

async fn next(rx: &mut mpsc::UnboundedReceiver<usize>) -> usize {
    tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("history worker did not reach its barrier")
        .expect("history worker channel closed")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires vectors emitted by the checked Lean model"]
async fn lean_vectors_match_observed_stream_supersession() {
    let path = std::env::var("OPENSESAME_SOURCE_HISTORY_VECTORS").unwrap();
    let vectors = std::fs::read_to_string(path).unwrap();
    let mut seen = BTreeSet::new();
    for line in vectors.lines().filter(|line| line.starts_with("stream\t")) {
        let fields: Vec<_> = line.split('\t').collect();
        assert_eq!(fields.len(), 3);
        let observed = match fields[1] {
            "0" => false,
            "1" => true,
            _ => panic!("invalid observed-event bit"),
        };
        let expected = match fields[2] {
            "0" => false,
            "1" => true,
            _ => panic!("invalid publication bit"),
        };
        assert!(seen.insert(observed));
        let api = FakeWorkloadApi::start();
        let td = FakeTrustDomain::new(TD);
        let partner = FakeTrustDomain::new("partner.test");
        let gateway = td.issue_svid(GW, Duration::from_mins(10));
        api.push_snapshot(snapshot(&td, &[&gateway]));
        let ControlledSink {
            generations,
            sink,
            mut entered,
            mut completed,
            gates,
        } = controlled_sink();
        let handle = SpiffeSource::start(config(&api, Duration::from_secs(5)), sink).unwrap();
        streaming(&handle, 2).await;
        api.push_snapshot(federated(
            &td,
            &gateway,
            &[("partner.test", partner.bundle_der())],
        ));
        assert_eq!(next(&mut entered).await, 1);
        if observed {
            api.deny_all(tonic::Status::unauthenticated("source revoked"));
            withdrawn_promptly(&handle).await;
        }
        gates[0].add_permits(1);
        assert_eq!(next(&mut completed).await, 1);
        if expected {
            streaming(&handle, 3).await;
        }
        let actual = generations.checked_current(None).is_ok_and(|current| {
            current
                .peer_trust
                .contains_key(&TrustProfileRef::new("partner.test").unwrap())
        });
        assert_eq!(actual, expected, "{line}");
        handle.stop().await;
        api.shutdown().await;
    }
    assert_eq!(seen.len(), 2, "model must emit both stream-event cases");
}

fn federated(
    td: &FakeTrustDomain,
    gateway: &IssuedSvid,
    bundles: &[(&str, Vec<u8>)],
) -> opensesame_spiffe_source::fake::pb::X509svidResponse {
    FakeWorkloadApi::snapshot(vec![gateway.to_proto(&td.bundle_der(), "")], bundles)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn observed_denial_withdraws_before_the_superseded_write_finishes() {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let partner = FakeTrustDomain::new("partner.test");
    let gateway = td.issue_svid(GW, Duration::from_mins(10));
    api.push_snapshot(snapshot(&td, &[&gateway]));
    let ControlledSink {
        generations,
        sink,
        mut entered,
        mut completed,
        gates,
    } = controlled_sink();
    let handle = SpiffeSource::start(config(&api, Duration::from_secs(5)), sink).unwrap();
    streaming(&handle, 2).await;
    api.push_snapshot(federated(
        &td,
        &gateway,
        &[("partner.test", partner.bundle_der())],
    ));
    assert_eq!(next(&mut entered).await, 1);
    assert!(generations.checked_current(None).is_ok());

    api.deny_all(tonic::Status::unauthenticated("source revoked"));
    withdrawn_promptly(&handle).await;
    assert!(generations.checked_current(None).is_err());
    gates[0].add_permits(1);
    assert_eq!(next(&mut completed).await, 1);
    assert!(generations.checked_current(None).is_err());
    handle.stop().await;
    api.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn observed_reduction_supersedes_pending_addition_and_old_result_cannot_publish() {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let partner = FakeTrustDomain::new("partner.test");
    let third = FakeTrustDomain::new("third.test");
    let gateway = td.issue_svid(GW, Duration::from_mins(10));
    api.push_snapshot(federated(
        &td,
        &gateway,
        &[("partner.test", partner.bundle_der())],
    ));
    let ControlledSink {
        generations,
        sink,
        mut entered,
        mut completed,
        gates,
    } = controlled_sink();
    let handle = SpiffeSource::start(config(&api, Duration::from_secs(5)), sink).unwrap();
    streaming(&handle, 2).await;
    api.push_snapshot(federated(
        &td,
        &gateway,
        &[
            ("partner.test", partner.bundle_der()),
            ("third.test", third.bundle_der()),
        ],
    ));
    assert_eq!(next(&mut entered).await, 1);
    api.push_snapshot(snapshot(&td, &[&gateway]));
    assert_eq!(next(&mut entered).await, 2);
    withdrawn_promptly(&handle).await;
    assert!(generations.checked_current(None).is_err());

    gates[0].add_permits(1);
    assert_eq!(next(&mut completed).await, 1);
    assert!(generations.checked_current(None).is_err());
    gates[1].add_permits(1);
    streaming(&handle, 4).await;
    let active = generations.checked_current(None).unwrap();
    assert!(!active
        .peer_trust
        .contains_key(&TrustProfileRef::new("partner.test").unwrap()));
    assert!(!active
        .peer_trust
        .contains_key(&TrustProfileRef::new("third.test").unwrap()));
    handle.stop().await;
    api.shutdown().await;
}

struct FullHistory(AtomicUsize);

impl GenerationHistory for FullHistory {
    fn reserve(&self, _names: BTreeSet<TrustProfileRef>) -> Result<HistoryWrite, TransportError> {
        if self.0.fetch_add(1, Ordering::SeqCst) == 0 {
            Ok(Box::pin(async { Ok(()) }))
        } else {
            Err(TransportError::SourceUnsupported)
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn saturated_history_refuses_new_snapshot_and_withdraws_immediately() {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let partner = FakeTrustDomain::new("partner.test");
    let gateway = td.issue_svid(GW, Duration::from_mins(10));
    api.push_snapshot(snapshot(&td, &[&gateway]));
    let initial = GenerationCandidate::default()
        .into_generation(0, Utc::now())
        .unwrap();
    let generations = TransportGenerations::new(initial);
    let sink = Arc::new(TransportGenerationsSink::with_history(
        Arc::clone(&generations),
        Arc::new(FullHistory(AtomicUsize::new(0))),
    ));
    let handle = SpiffeSource::start(config(&api, Duration::from_secs(5)), sink).unwrap();
    streaming(&handle, 2).await;
    api.push_snapshot(federated(
        &td,
        &gateway,
        &[("partner.test", partner.bundle_der())],
    ));
    withdrawn_promptly(&handle).await;
    assert!(generations.checked_current(None).is_err());
    handle.stop().await;
    api.shutdown().await;
}

struct ToggleHistory(Arc<AtomicBool>);

impl GenerationHistory for ToggleHistory {
    fn reserve(&self, _names: BTreeSet<TrustProfileRef>) -> Result<HistoryWrite, TransportError> {
        if self.0.load(Ordering::SeqCst) {
            // A store failure need not share the source-ownership error code.
            Err(TransportError::malformed("temporary history failure"))
        } else {
            Ok(Box::pin(async { Ok(()) }))
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cleared_history_failure_recovers_without_a_new_snapshot() {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let partner = FakeTrustDomain::new("partner.test");
    let gateway = td.issue_svid(GW, Duration::from_mins(10));
    api.push_snapshot(snapshot(&td, &[&gateway]));
    let initial = GenerationCandidate::default()
        .into_generation(0, Utc::now())
        .unwrap();
    let generations = TransportGenerations::new(initial);
    let unavailable = Arc::new(AtomicBool::new(false));
    let sink = Arc::new(TransportGenerationsSink::with_history(
        Arc::clone(&generations),
        Arc::new(ToggleHistory(Arc::clone(&unavailable))),
    ));
    let handle = SpiffeSource::start(config(&api, Duration::from_secs(5)), sink).unwrap();
    streaming(&handle, 2).await;
    unavailable.store(true, Ordering::SeqCst);
    api.push_snapshot(federated(
        &td,
        &gateway,
        &[("partner.test", partner.bundle_der())],
    ));
    withdrawn_promptly(&handle).await;
    assert!(generations.checked_current(None).is_err());
    unavailable.store(false, Ordering::SeqCst);
    // No new push: reconnect must replay the latest state from the server.
    handle
        .wait_for(Duration::from_secs(5), |status| {
            status.phase == opensesame_spiffe_source::SourcePhase::Streaming
                && status.generation.is_some_and(|number| number > 2)
        })
        .await
        .expect("source reconnects after storage recovers");
    assert!(generations
        .checked_current(None)
        .unwrap()
        .peer_trust
        .contains_key(&TrustProfileRef::new("partner.test").unwrap()));
    handle.stop().await;
    api.shutdown().await;
}
