//! Synthetic Workload API regressions for withdrawal and outage policy.

#[path = "support/policy.rs"]
mod policy;

use std::time::Duration;

use opensesame_domain::TransportError;
use opensesame_spiffe_source::fake::{FakeTrustDomain, FakeWorkloadApi};
use opensesame_spiffe_source::sink::recording::{RecordingSink, SinkEvent};
use opensesame_spiffe_source::{SourcePhase, SpiffeSource, SpiffeSourceConfig};
use policy::{config, snapshot, streaming, withdrawn_promptly, GW, TD, WAIT};

async fn reconnect_with_rejected_snapshot_keeps_the_original_outage_deadline(profile_error: bool) {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let gateway = td.issue_svid(GW, Duration::from_mins(10));
    api.push_snapshot(snapshot(&td, &[&gateway]));
    let sink = RecordingSink::shared();
    let handle =
        SpiffeSource::start(config(&api, Duration::from_millis(800)), sink.clone()).unwrap();
    streaming(&handle, 1).await;

    let expected_error = if profile_error {
        let mut spec =
            opensesame_spiffe_source::fake::SvidSpec::conforming(GW, Duration::from_mins(10));
        spec.eku = opensesame_spiffe_source::fake::Eku::ServerOnly;
        api.push_snapshot(snapshot(&td, &[&td.issue(&spec)]));
        "svid_profile"
    } else {
        sink.reject_activations(Some(TransportError::KeyPairMismatch));
        api.push_snapshot(snapshot(&td, &[&gateway]));
        "key_pair_mismatch"
    };
    handle
        .wait_for(WAIT, |s| s.last_error.as_deref() == Some(expected_error))
        .await
        .unwrap();
    api.close_streams();
    let reconnected = handle
        .wait_for(WAIT, |s| {
            s.connections >= 2
                && s.outage_since.is_some()
                && s.last_error.as_deref() == Some(expected_error)
        })
        .await
        .unwrap();
    assert_eq!(reconnected.phase, SourcePhase::Outage);
    let deadline = reconnected.retain_until.expect("outage deadline");
    assert!(
        deadline
            <= reconnected.outage_since.unwrap() + opensesame_time::Duration::milliseconds(800)
    );
    assert!(deadline < reconnected.not_after.unwrap());

    let status = withdrawn_promptly(&handle).await;
    assert_eq!(status.last_error.as_deref(), Some("evidence_expired"));
    assert_eq!(
        sink.last(),
        Some(SinkEvent::Withdrawn(TransportError::EvidenceExpired))
    );

    sink.reject_activations(None);
    api.push_snapshot(snapshot(&td, &[&gateway]));
    streaming(&handle, 2).await;
    handle.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rejected_activation_after_reconnect_cannot_extend_the_outage() {
    reconnect_with_rejected_snapshot_keeps_the_original_outage_deadline(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invalid_profile_after_reconnect_cannot_end_the_outage_or_extend_its_deadline() {
    reconnect_with_rejected_snapshot_keeps_the_original_outage_deadline(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stalled_reconnection_cannot_extend_the_outage_deadline() {
    let dir = tempfile::Builder::new()
        .prefix("os-spiffe-stalled-")
        .tempdir()
        .unwrap();
    let api = FakeWorkloadApi::start_at(dir.path());
    let socket_path = api.socket_path().to_owned();
    let td = FakeTrustDomain::new(TD);
    let gateway = td.issue_svid(GW, Duration::from_mins(10));
    api.push_snapshot(snapshot(&td, &[&gateway]));
    let sink = RecordingSink::shared();
    let handle =
        SpiffeSource::start(config(&api, Duration::from_millis(1500)), sink.clone()).unwrap();
    streaming(&handle, 1).await;
    api.shutdown().await;

    // Accept a connection but never complete the gRPC handshake or RPC.
    let listener = tokio::net::UnixListener::bind(&socket_path).unwrap();
    let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel();
    let stalled = tokio::spawn(async move {
        let (_connection, _) = listener.accept().await.unwrap();
        let _ = accepted_tx.send(());
        std::future::pending::<()>().await;
    });
    tokio::time::timeout(Duration::from_secs(2), accepted_rx)
        .await
        .expect("source must reconnect")
        .unwrap();

    let status = withdrawn_promptly(&handle).await;
    assert_eq!(status.last_error.as_deref(), Some("evidence_expired"));
    assert_eq!(
        sink.last(),
        Some(SinkEvent::Withdrawn(TransportError::EvidenceExpired))
    );
    stalled.abort();
    handle.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stalled_rpc_opening_cannot_extend_the_outage_deadline() {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let gateway = td.issue_svid(GW, Duration::from_mins(10));
    api.push_snapshot(snapshot(&td, &[&gateway]));
    let sink = RecordingSink::shared();
    let handle =
        SpiffeSource::start(config(&api, Duration::from_millis(800)), sink.clone()).unwrap();
    streaming(&handle, 1).await;
    api.stall_on_reconnect();
    tokio::time::timeout(Duration::from_secs(2), async {
        while api.stalled_opens() == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("source must attempt a new material RPC");

    let status = withdrawn_promptly(&handle).await;
    assert_eq!(status.last_error.as_deref(), Some("evidence_expired"));
    assert_eq!(
        sink.last(),
        Some(SinkEvent::Withdrawn(TransportError::EvidenceExpired))
    );
    handle.stop().await;
    api.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_interrupts_a_stalled_initial_connection() {
    let dir = tempfile::Builder::new()
        .prefix("os-spiffe-stalled-stop-")
        .tempdir()
        .unwrap();
    let socket_path = dir.path().join("api.sock");
    let listener = tokio::net::UnixListener::bind(&socket_path).unwrap();
    let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel();
    let stalled = tokio::spawn(async move {
        let (_connection, _) = listener.accept().await.unwrap();
        let _ = accepted_tx.send(());
        std::future::pending::<()>().await;
    });
    let config = SpiffeSourceConfig::deployment_plane(GW, &socket_path).unwrap();
    let handle = SpiffeSource::start(config, RecordingSink::shared()).unwrap();
    tokio::time::timeout(Duration::from_secs(2), accepted_rx)
        .await
        .expect("source must connect")
        .unwrap();

    tokio::time::timeout(Duration::from_secs(2), handle.stop())
        .await
        .expect("stop must interrupt the stalled connection");
    stalled.abort();
}
