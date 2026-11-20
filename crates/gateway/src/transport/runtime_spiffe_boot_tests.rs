//! SPIFFE listener bind gate at startup (Codex P2: withdrawn + generation).
use super::runtime::spiffe_first_ready_to_bind;
use opensesame_spiffe_source::{SourcePhase, SourceStatus};

#[test]
fn a_withdrawn_first_generation_is_not_bindable() {
    let mut status = SourceStatus::initial("spiffe://example.test/gateway");
    status.generation = Some(1);
    status.phase = SourcePhase::Withdrawn;
    assert!(
        !spiffe_first_ready_to_bind(&status),
        "withdrawn sources retain generation until the sink clears it"
    );
}

#[test]
fn a_stopped_source_is_not_bindable() {
    let mut status = SourceStatus::initial("spiffe://example.test/gateway");
    status.generation = Some(1);
    status.phase = SourcePhase::Stopped;
    assert!(!spiffe_first_ready_to_bind(&status));
}

#[test]
fn a_streaming_generation_is_bindable() {
    let mut status = SourceStatus::initial("spiffe://example.test/gateway");
    status.generation = Some(1);
    status.phase = SourcePhase::Streaming;
    assert!(spiffe_first_ready_to_bind(&status));
}