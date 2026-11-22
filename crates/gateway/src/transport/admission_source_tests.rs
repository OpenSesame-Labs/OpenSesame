//! Admission rechecks the source fence after the outer middleware.
use super::*;
use opensesame_time::Utc;
use opensesame_transport_security::testkit::DisposableCa;
use opensesame_transport_security::{GenerationCandidate, TransportGenerations};
use std::sync::Arc;

#[tokio::test]
async fn expired_source_is_refused_at_service_admission() {
    let mut st = state(bridge_set(), 1).await;
    let ca = DisposableCa::new("admission");
    let identity = Arc::new(ca.issue_server("localhost").identity());
    let candidate = GenerationCandidate {
        identity: Some(identity),
        identity_required: true,
        ..Default::default()
    };
    let gens = TransportGenerations::new(candidate.clone().into_generation(1, Utc::now()).unwrap());
    let owner = gens.source_owner();
    let reserved = gens.claim_source(&owner).unwrap();
    let epoch = gens
        .activate_from_source(&owner, reserved, candidate)
        .unwrap();
    st.transport = Some(super::super::test_support::runtime_serving(
        gens.clone(),
        bridge_set(),
        super::super::test_support::mtls_config(),
    ));
    let extensions = tls_extensions(&peer("bridge.test", THUMB_A, epoch), epoch);
    assert!(require_service_caller(
        &st,
        &extensions,
        BindingPurpose::NatsAuthBridge,
        operations::NATS_CALLOUT_DECIDE
    )
    .is_ok());
    gens.tighten_source_deadline(
        &owner,
        epoch,
        Utc::now() - opensesame_time::Duration::seconds(1),
    )
    .unwrap();
    assert!(gens.current().withdrawn.is_none());
    let refused = require_service_caller(
        &st,
        &extensions,
        BindingPurpose::NatsAuthBridge,
        operations::NATS_CALLOUT_DECIDE,
    )
    .unwrap_err();
    assert_eq!(code(&refused), "evidence_expired");
}
