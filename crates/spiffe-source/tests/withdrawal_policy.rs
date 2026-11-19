//! Synthetic Workload API regressions for withdrawal and outage policy.

#[path = "support/policy.rs"]
mod policy;

use std::time::Duration;

use opensesame_domain::TransportError;
use opensesame_spiffe_source::fake::{FakeTrustDomain, FakeWorkloadApi, Status};
use opensesame_spiffe_source::sink::recording::{RecordingSink, SinkEvent};
use opensesame_spiffe_source::{SourcePhase, SpiffeSource};
use policy::{config, snapshot, streaming, withdrawn_promptly, GW, TD, WAIT};

const WK: &str = "spiffe://example.test/opensesame/worker";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_empty_snapshot_withdraws_the_only_identity_then_recovers() {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let gateway = td.issue_svid(GW, Duration::from_mins(10));
    api.push_snapshot(snapshot(&td, &[&gateway]));
    let sink = RecordingSink::shared();
    let handle = SpiffeSource::start(config(&api, Duration::from_secs(5)), sink.clone()).unwrap();
    streaming(&handle, 1).await;

    api.revoke_all();
    let status = withdrawn_promptly(&handle).await;
    assert_eq!(status.last_error.as_deref(), Some("svid_not_issued"));
    assert_eq!(
        sink.last(),
        Some(SinkEvent::Withdrawn(TransportError::IdentityMissing))
    );

    // An invalid later update must not make a withdrawn generation appear live.
    let mut spec =
        opensesame_spiffe_source::fake::SvidSpec::conforming(GW, Duration::from_mins(10));
    spec.eku = opensesame_spiffe_source::fake::Eku::ServerOnly;
    api.push_snapshot(snapshot(&td, &[&td.issue(&spec)]));
    let status = handle
        .wait_for(WAIT, |s| s.last_error.as_deref() == Some("svid_profile"))
        .await
        .unwrap();
    assert_eq!(status.phase, SourcePhase::Withdrawn);
    assert_eq!(
        status.credential_status(chrono::Utc::now()),
        opensesame_domain::CredentialStatus::Expired { generation: 1 }
    );
    assert_eq!(
        sink.last(),
        Some(SinkEvent::Withdrawn(TransportError::IdentityMissing))
    );

    api.push_snapshot(snapshot(&td, &[&gateway]));
    streaming(&handle, 2).await;
    handle.stop().await;
}

async fn material_rpc_denial_withdraws_and_recovers(denial: Status) {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let gateway = td.issue_svid(GW, Duration::from_mins(10));
    api.push_snapshot(snapshot(&td, &[&gateway]));
    let sink = RecordingSink::shared();
    let handle = SpiffeSource::start(config(&api, Duration::from_secs(5)), sink.clone()).unwrap();
    streaming(&handle, 1).await;

    api.deny_all(denial);
    withdrawn_promptly(&handle).await;
    assert_eq!(
        sink.last(),
        Some(SinkEvent::Withdrawn(TransportError::IdentityMissing))
    );

    api.push_snapshot(snapshot(&td, &[&gateway]));
    streaming(&handle, 2).await;
    handle.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_identity_issued_on_the_stream_withdraws_and_recovers() {
    material_rpc_denial_withdraws_and_recovers(Status::permission_denied("no identity issued"))
        .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn permission_denied_on_the_stream_withdraws_and_recovers() {
    material_rpc_denial_withdraws_and_recovers(Status::permission_denied(
        "workload permission denied",
    ))
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unauthenticated_on_the_stream_withdraws_and_recovers() {
    material_rpc_denial_withdraws_and_recovers(Status::unauthenticated(
        "workload not authenticated",
    ))
    .await;
}

async fn denial_opening_a_reconnected_stream_withdraws(denial: Status, code: &str) {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let gateway = td.issue_svid(GW, Duration::from_mins(10));
    api.push_snapshot(snapshot(&td, &[&gateway]));
    let sink = RecordingSink::shared();
    let handle = SpiffeSource::start(config(&api, Duration::from_secs(30)), sink.clone()).unwrap();
    streaming(&handle, 1).await;

    api.deny_on_reconnect(denial);
    let status = withdrawn_promptly(&handle).await;
    assert_eq!(status.last_error.as_deref(), Some(code));
    assert_eq!(
        sink.last(),
        Some(SinkEvent::Withdrawn(TransportError::IdentityMissing))
    );

    api.push_snapshot(snapshot(&td, &[&gateway]));
    streaming(&handle, 2).await;
    handle.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_identity_denial_on_reconnect_withdraws_the_active_generation() {
    denial_opening_a_reconnected_stream_withdraws(
        Status::permission_denied("no identity issued"),
        "svid_not_issued",
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn permission_denial_on_reconnect_withdraws_the_active_generation() {
    denial_opening_a_reconnected_stream_withdraws(
        Status::permission_denied("workload permission denied"),
        "workload_api_denied",
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unauthenticated_on_reconnect_withdraws_the_active_generation() {
    denial_opening_a_reconnected_stream_withdraws(
        Status::unauthenticated("workload not authenticated"),
        "workload_api_unauthenticated",
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unattributed_missing_bundle_fails_closed_until_a_valid_snapshot() {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let gateway = td.issue_svid(GW, Duration::from_mins(10));
    let worker = td.issue_svid(WK, Duration::from_mins(10));
    api.push_snapshot(snapshot(&td, &[&gateway]));
    let sink = RecordingSink::shared();
    let handle = SpiffeSource::start(config(&api, Duration::from_secs(5)), sink.clone()).unwrap();
    streaming(&handle, 1).await;

    api.push_snapshot(FakeWorkloadApi::snapshot(
        vec![
            gateway.to_proto(&td.bundle_der(), ""),
            worker.to_proto(&[], ""),
        ],
        &[],
    ));
    let status = withdrawn_promptly(&handle).await;
    assert_eq!(status.last_error.as_deref(), Some("bundle_missing"));
    assert_eq!(
        sink.last(),
        Some(SinkEvent::Withdrawn(TransportError::TrustUnknown))
    );

    api.push_snapshot(snapshot(&td, &[&gateway, &worker]));
    streaming(&handle, 2).await;
    handle.stop().await;
}

async fn unparseable_svid_withdraws(also_contains_gateway: bool) {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let gateway = td.issue_svid(GW, Duration::from_mins(10));
    let worker = td.issue_svid(WK, Duration::from_mins(10));
    api.push_snapshot(snapshot(&td, &[&gateway]));
    let sink = RecordingSink::shared();
    let handle = SpiffeSource::start(config(&api, Duration::from_secs(5)), sink.clone()).unwrap();
    streaming(&handle, 1).await;

    let mut malformed_worker = worker.to_proto(&td.bundle_der(), "");
    malformed_worker.spiffe_id.clear();
    let mut entries = vec![malformed_worker];
    if also_contains_gateway {
        entries.push(gateway.to_proto(&td.bundle_der(), ""));
    }
    api.push_snapshot(FakeWorkloadApi::snapshot(entries, &[]));
    let status = withdrawn_promptly(&handle).await;
    assert_eq!(status.last_error.as_deref(), Some("workload_api_message"));
    assert!(matches!(
        sink.last(),
        Some(SinkEvent::Withdrawn(
            TransportError::MalformedConfiguration(_)
        ))
    ));

    api.push_snapshot(snapshot(&td, &[&gateway, &worker]));
    streaming(&handle, 2).await;
    handle.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unrelated_unparseable_svid_conservatively_withdraws() {
    unparseable_svid_withdraws(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn omitted_gateway_with_unparseable_worker_withdraws() {
    unparseable_svid_withdraws(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_the_handle_stops_further_generation_activation() {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let gateway = td.issue_svid(GW, Duration::from_mins(10));
    api.push_snapshot(snapshot(&td, &[&gateway]));
    let sink = RecordingSink::shared();
    let handle = SpiffeSource::start(config(&api, Duration::from_secs(5)), sink.clone());
    streaming(&handle, 1).await;

    let mut status = handle.status();
    drop(handle);
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if status.borrow().phase == SourcePhase::Stopped {
                break;
            }
            status
                .changed()
                .await
                .expect("status task ended before it published Stopped");
        }
        let _ = status.changed().await;
    })
    .await
    .expect("dropping the handle stops the source");

    assert_eq!(status.borrow().phase, SourcePhase::Stopped);
    assert_eq!(
        sink.last(),
        Some(SinkEvent::Withdrawn(TransportError::SourceUnsupported))
    );
    let activations = sink
        .events()
        .into_iter()
        .filter(|event| matches!(event, SinkEvent::Activated { .. }))
        .count();

    api.push_snapshot(snapshot(&td, &[&gateway]));
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(
        sink.events()
            .into_iter()
            .filter(|event| matches!(event, SinkEvent::Activated { .. }))
            .count(),
        activations,
        "a snapshot after drop activated another generation"
    );
    assert!(sink.events().iter().all(|event| match event {
        SinkEvent::Activated { number, .. } => *number == 1,
        SinkEvent::Withdrawn(_) => true,
    }));
}
