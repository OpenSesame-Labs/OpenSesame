//! A fenced generation must not appear installed or healthy.
use super::*;
use crate::transport::test_support;
use opensesame_domain::transport::TransportError;
use opensesame_time::{Duration, Utc};
use opensesame_transport_security::testkit::DisposableCa;
use opensesame_transport_security::{GenerationCandidate, TransportGenerations};
use std::sync::Arc;

#[test]
fn quarantine_and_expiry_are_unloaded_with_revocation_precedence() {
    let ca = DisposableCa::new("status-server");
    let identity = Arc::new(ca.issue_server("localhost").identity());
    let thumb = identity.leaf_thumbprint_sha256();
    let candidate = GenerationCandidate {
        identity: Some(identity),
        identity_required: true,
        ..Default::default()
    };
    let gens = TransportGenerations::new(candidate.clone().into_generation(1, Utc::now()).unwrap());
    let runtime = test_support::runtime_serving(
        Arc::clone(&gens),
        test_support::set(vec![]),
        test_support::mtls_config(),
    );
    let lifecycle = LifecycleState::new();
    let status = || {
        view(
            &runtime,
            &TransportFacts::default(),
            &CapabilityOutcome::Supported,
            &lifecycle,
        )
    };
    assert!(matches!(status().runtime, RuntimeStatus::Loaded { .. }));
    let owner = gens.source_owner();
    let reserved = gens.claim_source(&owner).unwrap();
    assert!(matches!(status().runtime, RuntimeStatus::NotLoaded));
    assert!(!matches!(
        status().credential,
        CredentialStatus::Configured { .. }
    ));
    let epoch = gens
        .activate_from_source(&owner, reserved, candidate)
        .unwrap();
    assert!(matches!(status().runtime, RuntimeStatus::Loaded { .. }));
    gens.tighten_source_deadline(
        &owner,
        epoch,
        Utc::now() - opensesame_time::Duration::seconds(1),
    )
    .unwrap();
    let expired = status();
    assert!(matches!(expired.runtime, RuntimeStatus::NotLoaded));
    assert!(matches!(
        expired.credential,
        CredentialStatus::Expired { .. }
    ));
    lifecycle.deny(&thumb);
    assert!(matches!(
        status().credential,
        CredentialStatus::Revoked { .. }
    ));
    assert_eq!(
        gens.withdraw_from_source(&owner, epoch, TransportError::EvidenceRevoked),
        Ok(())
    );
    assert!(matches!(
        status().credential,
        CredentialStatus::Revoked { .. }
    ));
}
