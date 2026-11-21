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

    // An invalid later update must not make a withdrawn generation appear live
    // nor re-label the standing withdrawal reason: with nothing retained, the
    // refusal code documents no live generation.
    let mut spec =
        opensesame_spiffe_source::fake::SvidSpec::conforming(GW, Duration::from_mins(10));
    spec.eku = opensesame_spiffe_source::fake::Eku::ServerOnly;
    api.push_snapshot(snapshot(&td, &[&td.issue(&spec)]));
    let relabelled = handle
        .wait_for(Duration::from_secs(3), |s| {
            s.last_error.as_deref() == Some("svid_profile")
        })
        .await;
    assert!(
        relabelled.is_err(),
        "refusal code must not re-label a standing withdrawal"
    );
    let status = handle
        .wait_for(WAIT, |s| s.last_error.as_deref() == Some("svid_not_issued"))
        .await
        .expect("svid_not_issued still stands");
    assert_eq!(status.phase, SourcePhase::Withdrawn);
    assert_eq!(
        status.credential_status(opensesame_time::Utc::now()),
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

async fn material_rpc_denial_withdraws_and_recovers(denial: Status, code: &str) {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let gateway = td.issue_svid(GW, Duration::from_mins(10));
    api.push_snapshot(snapshot(&td, &[&gateway]));
    let sink = RecordingSink::shared();
    let handle = SpiffeSource::start(config(&api, Duration::from_secs(5)), sink.clone()).unwrap();
    streaming(&handle, 1).await;

    api.deny_all(denial);
    let status = withdrawn_promptly(&handle).await;
    // A denial is immediate withdrawal. An outage would keep `Outage`, set
    // `outage_since` / `retain_until`, and leave withdrawals at 0.
    assert_eq!(status.phase, SourcePhase::Withdrawn);
    assert_eq!(status.last_error.as_deref(), Some(code));
    assert_eq!(status.generation, Some(1));
    assert_eq!(status.withdrawals, 1);
    assert!(status.outage_since.is_none());
    assert!(status.retain_until.is_none());
    assert_eq!(
        status.credential_status(opensesame_time::Utc::now()),
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_identity_issued_on_the_stream_withdraws_and_recovers() {
    material_rpc_denial_withdraws_and_recovers(
        Status::permission_denied("no identity issued"),
        "svid_not_issued",
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn permission_denied_on_the_stream_withdraws_and_recovers() {
    material_rpc_denial_withdraws_and_recovers(
        Status::permission_denied("workload permission denied"),
        "workload_api_denied",
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unauthenticated_on_the_stream_withdraws_and_recovers() {
    material_rpc_denial_withdraws_and_recovers(
        Status::unauthenticated("workload not authenticated"),
        "workload_api_unauthenticated",
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stream_outage_retains_the_generation_until_a_denial_withdraws_it() {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let gateway = td.issue_svid(GW, Duration::from_mins(10));
    api.push_snapshot(snapshot(&td, &[&gateway]));
    let sink = RecordingSink::shared();
    let config = config(&api, Duration::from_secs(30))
        .with_reconnect(opensesame_spiffe_source::ReconnectPolicy {
            initial: Duration::from_millis(800),
            max: Duration::from_millis(800),
            jitter_permille: 0,
        })
        .expect("reconnect policy");
    let handle = SpiffeSource::start(config, sink.clone()).unwrap();
    streaming(&handle, 1).await;

    api.close_streams();
    let outage = handle
        .wait_for(WAIT, |s| {
            s.phase == SourcePhase::Outage && s.connections == 1 && s.retain_until.is_some()
        })
        .await
        .expect("a broken stream is an outage, not a withdrawal");
    assert_eq!(outage.generation, Some(1));
    assert_eq!(outage.withdrawals, 0);
    assert!(outage.outage_since.is_some());
    let deadline = outage.retain_until.expect("outage deadline");
    assert!(deadline > opensesame_time::Utc::now() + opensesame_time::Duration::seconds(10));
    assert!(matches!(
        sink.last(),
        Some(SinkEvent::Activated { number: 1, .. })
    ));

    api.deny_on_reconnect(Status::permission_denied("workload permission denied"));
    let status = withdrawn_promptly(&handle).await;
    assert_eq!(status.phase, SourcePhase::Withdrawn);
    assert_eq!(status.last_error.as_deref(), Some("workload_api_denied"));
    assert!(status.retain_until.is_none());
    assert_eq!(status.withdrawals, 1);
    assert_eq!(status.generation, Some(1));
    assert!(opensesame_time::Utc::now() < deadline);
    assert_eq!(
        sink.last(),
        Some(SinkEvent::Withdrawn(TransportError::IdentityMissing))
    );
    handle.stop().await;
}

async fn denial_opening_a_reconnected_stream_withdraws(denial: Status, code: &str) {
    let api = FakeWorkloadApi::start();
    let td = FakeTrustDomain::new(TD);
    let gateway = td.issue_svid(GW, Duration::from_mins(10));
    api.push_snapshot(snapshot(&td, &[&gateway]));
    let sink = RecordingSink::shared();
    let handle = SpiffeSource::start(config(&api, Duration::from_secs(30)), sink.clone()).unwrap();
    streaming(&handle, 1).await;

    api.close_streams();
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
    let handle = SpiffeSource::start(config(&api, Duration::from_secs(5)), sink.clone()).unwrap();
    streaming(&handle, 1).await;

    let mut status = handle.status();
    drop(handle);
    tokio::time::timeout(Duration::from_secs(3), async {
        while status.borrow().phase != SourcePhase::Stopped {
            status
                .changed()
                .await
                .expect("status task ended before it published Stopped");
        }
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
    tokio::time::sleep(Duration::from_millis(500)).await;
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
