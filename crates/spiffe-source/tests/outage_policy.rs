//! Synthetic Workload API regressions for withdrawal and outage policy.

#[path = "support/policy.rs"]
#[allow(dead_code)]
mod policy;

use std::time::Duration;

use opensesame_domain::TransportError;
use opensesame_spiffe_source::fake::{FakeTrustDomain, FakeWorkloadApi};
use opensesame_spiffe_source::sink::recording::{RecordingSink, SinkEvent};
use opensesame_spiffe_source::{
    ReconnectPolicy, SourcePhase, SourceStatus, SpiffeSource, SpiffeSourceConfig,
    SpiffeSourceHandle,
};
use opensesame_time::{DateTime, Utc};
use policy::{config, snapshot, streaming, GW, TD, WAIT};

fn slow_reconnect(
    api: &FakeWorkloadApi,
    max_stale: Duration,
    initial: Duration,
) -> SpiffeSourceConfig {
    config(api, max_stale)
        .with_reconnect(ReconnectPolicy {
            initial,
            max: initial,
            jitter_permille: 0,
        })
        .expect("reconnect policy")
}

async fn opened_outage(handle: &SpiffeSourceHandle) -> (DateTime<Utc>, DateTime<Utc>) {
    let status = handle
        .wait_for(WAIT, |s| {
            s.phase == SourcePhase::Outage && s.connections == 1 && s.retain_until.is_some()
        })
        .await
        .expect("outage before the next stream opens");
    (
        status.outage_since.expect("outage start"),
        status.retain_until.expect("outage deadline"),
    )
}

fn assert_same_window(status: &SourceStatus, since: DateTime<Utc>, deadline: DateTime<Utc>) {
    assert_eq!(status.phase, SourcePhase::Outage);
    assert_eq!(status.outage_since, Some(since));
    assert_eq!(status.retain_until, Some(deadline));
    assert_eq!(status.generation, Some(1));
    assert_eq!(status.withdrawals, 0);
}

/// Withdrawal must land on the window captured at the break.
///
/// Slack is shorter than the 800ms reconnect delay these tests use, so a
/// window armed again when the next stream starts cannot expire inside the
/// wait. The original window can.
async fn withdrawn_on_original_deadline(
    handle: &SpiffeSourceHandle,
    deadline: DateTime<Utc>,
) -> SourceStatus {
    let remaining =
        (deadline - Utc::now()).to_std().unwrap_or(Duration::ZERO) + Duration::from_millis(500);
    handle
        .wait_for(remaining, |s| {
            s.phase == SourcePhase::Withdrawn && s.last_error.as_deref() == Some("evidence_expired")
        })
        .await
        .unwrap_or_else(|err| panic!("outage deadline moved past {deadline:?}: {err}"))
}

async fn reconnect_with_rejected_snapshot_keeps_the_original_outage_deadline(profile_error: bool) {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let gateway = td.issue_svid(GW, Duration::from_mins(10));
    api.push_snapshot(snapshot(&td, &[&gateway]));
    let sink = RecordingSink::shared();
    let handle = SpiffeSource::start(
        slow_reconnect(
            &api,
            Duration::from_millis(2500),
            Duration::from_millis(800),
        ),
        sink.clone(),
    );
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
    let (since, deadline) = opened_outage(&handle).await;
    assert!(deadline <= since + opensesame_time::Duration::milliseconds(2500));
    let reconnected = handle
        .wait_for(WAIT, |s| {
            s.connections >= 2 && s.last_error.as_deref() == Some(expected_error)
        })
        .await
        .unwrap();
    assert_same_window(&reconnected, since, deadline);
    assert!(deadline < reconnected.not_after.unwrap());

    let status = withdrawn_on_original_deadline(&handle, deadline).await;
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
    let handle = SpiffeSource::start(
        slow_reconnect(
            &api,
            Duration::from_millis(2500),
            Duration::from_millis(800),
        ),
        sink.clone(),
    );
    streaming(&handle, 1).await;
    api.shutdown().await;
    let (since, deadline) = opened_outage(&handle).await;

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
    assert_same_window(&handle.current(), since, deadline);

    let status = withdrawn_on_original_deadline(&handle, deadline).await;
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
    let handle = SpiffeSource::start(
        slow_reconnect(
            &api,
            Duration::from_millis(2500),
            Duration::from_millis(800),
        ),
        sink.clone(),
    );
    streaming(&handle, 1).await;
    api.close_streams();
    api.stall_on_reconnect();
    let (since, deadline) = opened_outage(&handle).await;
    tokio::time::timeout(Duration::from_secs(2), async {
        while api.stalled_opens() == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("source must attempt a new material RPC");
    assert_same_window(&handle.current(), since, deadline);

    let status = withdrawn_on_original_deadline(&handle, deadline).await;
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
    let handle = SpiffeSource::start(config, RecordingSink::shared());
    tokio::time::timeout(Duration::from_secs(2), accepted_rx)
        .await
        .expect("source must connect")
        .unwrap();

    tokio::time::timeout(Duration::from_secs(2), handle.stop())
        .await
        .expect("stop must interrupt the stalled connection");
    stalled.abort();
}
