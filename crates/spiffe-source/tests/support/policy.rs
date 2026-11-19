//! Shared fixtures for the withdrawal and outage integration tests.

use std::time::Duration;

use opensesame_spiffe_source::fake::{FakeTrustDomain, FakeWorkloadApi, IssuedSvid};
use opensesame_spiffe_source::{
    ReconnectPolicy, SourcePhase, SourceStatus, SpiffeSourceConfig, SpiffeSourceHandle,
};

pub const TD: &str = "example.test";
pub const GW: &str = "spiffe://example.test/opensesame/gateway";
pub const WAIT: Duration = Duration::from_secs(10);

pub fn config(api: &FakeWorkloadApi, max_stale: Duration) -> SpiffeSourceConfig {
    SpiffeSourceConfig::deployment_plane(GW, api.socket_path())
        .unwrap()
        .with_max_stale(max_stale)
        .with_reconnect(ReconnectPolicy {
            initial: Duration::from_millis(20),
            max: Duration::from_millis(100),
            jitter_permille: 100,
        })
        .unwrap()
}

pub fn snapshot(
    td: &FakeTrustDomain,
    svids: &[&IssuedSvid],
) -> opensesame_spiffe_source::fake::pb::X509svidResponse {
    FakeWorkloadApi::snapshot(
        svids
            .iter()
            .map(|s| s.to_proto(&td.bundle_der(), ""))
            .collect(),
        &[],
    )
}

pub async fn streaming(handle: &SpiffeSourceHandle, generation: u64) -> SourceStatus {
    handle
        .wait_for(WAIT, |s| {
            s.phase == SourcePhase::Streaming && s.generation == Some(generation)
        })
        .await
        .unwrap_or_else(|s| panic!("expected streaming generation {generation}, got {s:?}"))
}

pub async fn withdrawn_promptly(handle: &SpiffeSourceHandle) -> SourceStatus {
    handle
        .wait_for(Duration::from_secs(3), |s| {
            s.phase == SourcePhase::Withdrawn
        })
        .await
        .unwrap_or_else(|s| panic!("expected prompt withdrawal, got {s:?}"))
}
