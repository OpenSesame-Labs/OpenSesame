use super::attest::AttestedPeer;
use super::binding_tests::{binding, now, set, spiffe, HEX_A};
use super::evidence_tests::attested;
use super::*;

fn matching_binding() -> ServiceBinding {
    binding(
        "bridge",
        spiffe("ns/prod/sa/nats-bridge"),
        BindingPurpose::NatsAuthBridge,
    )
}

fn admit(
    peer: VerifiedPeer,
    bindings: &ServiceBindingSet,
) -> Result<ServiceCaller, TransportError> {
    ServiceCaller::admit(
        peer,
        &BindingScope::Deployment,
        bindings,
        BindingPurpose::NatsAuthBridge,
        3,
        7,
        now(),
    )
}

#[test]
fn spiffe_evidence_uses_only_exact_id_but_still_checks_leaf_revocation() {
    let peer = attested(EvidenceSource::DirectTls, TransportPolicy::MtlsRequired)
        .into_verified_spiffe()
        .unwrap();
    assert_eq!(peer.identities(), &[spiffe("ns/prod/sa/nats-bridge")]);
    assert_eq!(peer.leaf_thumbprint_sha256(), HEX_A);
    assert!(admit(peer.clone(), &set(vec![matching_binding()])).is_ok());
    let mut revoked = matching_binding();
    revoked.denied_thumbprints.push(HEX_A.into());
    assert_eq!(
        admit(peer.clone(), &set(vec![revoked.clone()])).unwrap_err(),
        TransportError::EvidenceRevoked
    );
    revoked.enabled = false;
    assert_eq!(
        admit(peer.clone(), &set(vec![revoked])).unwrap_err(),
        TransportError::EvidenceRevoked
    );
    let by_thumbprint = binding(
        "thumb-only",
        PeerIdentitySelector::LeafThumbprintSha256(HEX_A.into()),
        BindingPurpose::NatsAuthBridge,
    );
    assert_eq!(
        admit(peer, &set(vec![by_thumbprint])).unwrap_err(),
        TransportError::PeerNotBound
    );
    let mut mixed = attested(EvidenceSource::DirectTls, TransportPolicy::MtlsRequired);
    mixed
        .identities
        .push(PeerIdentitySelector::DnsName("peer.example".into()));
    assert!(mixed.into_verified_spiffe().is_err());
}

#[test]
fn forwarding_keeps_the_ingress_selectors_restricted() {
    let ingress = attested(EvidenceSource::DirectTls, TransportPolicy::TrustedIngress)
        .into_verified_spiffe()
        .unwrap();
    let assertion = attested(
        EvidenceSource::TrustedIngressAssertion,
        TransportPolicy::TrustedIngress,
    );
    let peer = assertion
        .into_verified_with_ingress(ingress.clone())
        .unwrap();
    assert_eq!(peer.ingress().unwrap().identities(), ingress.identities());
    let by_thumbprint = binding(
        "thumb-only",
        PeerIdentitySelector::LeafThumbprintSha256(HEX_A.into()),
        BindingPurpose::NatsAuthBridge,
    );
    assert_eq!(
        admit(peer.clone(), &set(vec![by_thumbprint])).unwrap_err(),
        TransportError::PeerNotBound
    );
    let mut denied = matching_binding();
    denied.denied_thumbprints.push(HEX_A.into());
    assert_eq!(
        admit(peer, &set(vec![denied])).unwrap_err(),
        TransportError::EvidenceRevoked
    );
}

#[test]
fn preserved_ingress_cannot_be_substituted_into_direct_evidence() {
    let ingress = attested(EvidenceSource::DirectTls, TransportPolicy::TrustedIngress)
        .into_verified_spiffe()
        .unwrap();
    let direct: AttestedPeer = attested(EvidenceSource::DirectTls, TransportPolicy::MtlsRequired);
    assert!(direct.into_verified_with_ingress(ingress).is_err());
}

#[test]
fn direct_spiffe_constructor_refuses_a_raw_forwarded_ingress() {
    let ingress = attested(EvidenceSource::DirectTls, TransportPolicy::TrustedIngress);
    let mut assertion = attested(
        EvidenceSource::TrustedIngressAssertion,
        TransportPolicy::TrustedIngress,
    );
    assertion.ingress = Some(Box::new(ingress));
    assert_eq!(
        assertion.into_verified_spiffe().unwrap_err(),
        TransportError::ForwardedEvidenceUnverified
    );
}

#[test]
fn generic_constructor_refuses_raw_forwarded_ingress() {
    let ingress = attested(EvidenceSource::DirectTls, TransportPolicy::TrustedIngress);
    let mut assertion = attested(
        EvidenceSource::TrustedIngressAssertion,
        TransportPolicy::TrustedIngress,
    );
    assertion.ingress = Some(Box::new(ingress));
    assert_eq!(
        assertion.into_verified().unwrap_err(),
        TransportError::ForwardedEvidenceUnverified
    );
}
