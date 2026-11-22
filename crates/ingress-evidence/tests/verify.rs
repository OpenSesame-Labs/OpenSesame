//! `verify_originating` on its own: what the origin re-check constrains, and
//! the honest shape of what it produces.

mod support;

use std::sync::Arc;

use http::{HeaderMap, HeaderValue};
use opensesame_domain::transport::attest::AttestedPeer;
use opensesame_domain::transport::{
    EvidenceSource, PeerIdentitySelector, TlsVersion, TransportError, TransportPolicy,
    TrustProfileKind, VerifiedPeer,
};
use opensesame_ingress_evidence::{
    parse_client_cert_fields, verify_originating, BindingSetAdmission, ForwardedChain,
    IngressAdmission, IngressLimits,
};
use opensesame_time::{Duration, Utc};
use opensesame_transport_security::testkit::{IssuedLeaf, LeafSpec, SanEntry};
use opensesame_transport_security::TrustBundle;
use support::{byte_sequence, client_cert, Pki, TRUSTED_LISTENER};

fn ingress_peer(pki: &Pki, listener: &str) -> VerifiedPeer {
    let now = Utc::now();
    AttestedPeer {
        source: EvidenceSource::DirectTls,
        identities: vec![PeerIdentitySelector::DnsName("ingress.example.test".into())],
        leaf_thumbprint_sha256: pki.ingress.thumbprint.clone(),
        not_before: now - Duration::minutes(5),
        not_after: now + Duration::hours(1),
        trust_profile: Pki::ingress_profile(),
        trust_generation: 1,
        credential_generation: 1,
        listener: listener.to_owned(),
        policy: TransportPolicy::TrustedIngress,
        tls_version: TlsVersion::Tls13,
        authenticated_at: now,
        usable_until: now + Duration::minutes(5),
        ingress: None,
    }
    .into_verified()
    .expect("ingress peer")
}

fn chain_for(leaf: &IssuedLeaf, pki: &Pki) -> ForwardedChain {
    let mut headers = HeaderMap::new();
    headers.insert(
        "client-cert",
        HeaderValue::from_str(&client_cert(leaf)).expect("value"),
    );
    headers.insert(
        "client-cert-chain",
        HeaderValue::from_str(&byte_sequence(&pki.originating_int.ca_der())).expect("value"),
    );
    parse_client_cert_fields(&headers, &IngressLimits::DEFAULT).expect("chain parses")
}

fn code(result: Result<VerifiedPeer, TransportError>) -> String {
    match result {
        Ok(_) => "ok".into(),
        Err(error) => error.code().to_owned(),
    }
}

#[test]
fn accepted_evidence_is_labelled_as_an_ingress_assertion() {
    let pki = Pki::new();
    let ingress = ingress_peer(&pki, TRUSTED_LISTENER);
    let now = Utc::now();
    let peer = verify_originating(
        &chain_for(&pki.alice, &pki),
        &pki.originating_trust(),
        &ingress,
        now,
        TRUSTED_LISTENER,
    )
    .expect("alice verifies");
    assert_eq!(peer.source(), EvidenceSource::TrustedIngressAssertion);
    assert_eq!(peer.policy(), TransportPolicy::TrustedIngress);
    assert_eq!(peer.listener(), TRUSTED_LISTENER);
    assert_eq!(peer.leaf_thumbprint_sha256(), pki.alice.thumbprint);
    assert_eq!(peer.trust_profile(), &Pki::originating_profile());
    assert_eq!(peer.tls_version(), ingress.tls_version());
    assert_eq!(
        peer.credential_generation(),
        ingress.credential_generation()
    );
    assert!(
        peer.usable_until() <= ingress.usable_until(),
        "capped by the ingress's own bound"
    );
    let bound_ingress = peer.ingress().expect("ingress evidence carried");
    assert_eq!(
        bound_ingress.leaf_thumbprint_sha256(),
        pki.ingress.thumbprint
    );
    assert!(peer.identities().contains(&PeerIdentitySelector::SpiffeId(
        "spiffe://example.test/alice".into()
    )));
    assert!(peer
        .identities()
        .contains(&PeerIdentitySelector::DnsName("alice.example.test".into())));
}

#[test]
fn refuses_a_chain_that_does_not_reach_the_originating_bundle() {
    let pki = Pki::new();
    let ingress = ingress_peer(&pki, TRUSTED_LISTENER);
    let now = Utc::now();
    // Alice chains to the originating root, not to the ingress CA.
    let wrong_bundle = TrustBundle::from_pem(
        Pki::originating_profile(),
        TrustProfileKind::PrivateRoot,
        &pki.ingress_ca.ca_pem(),
    )
    .expect("bundle");
    assert_eq!(
        code(verify_originating(
            &chain_for(&pki.alice, &pki),
            &wrong_bundle,
            &ingress,
            now,
            TRUSTED_LISTENER
        )),
        "trust_unknown"
    );
    // The ingress's own certificate, from its own root, is not an originating client either.
    let ingress_as_client = chain_for(&pki.ingress, &pki);
    assert_eq!(
        code(verify_originating(
            &ingress_as_client,
            &pki.originating_trust(),
            &ingress,
            now,
            TRUSTED_LISTENER
        )),
        "trust_unknown"
    );
}

#[test]
fn refuses_expired_revoked_and_wrong_usage_leaves() {
    let pki = Pki::new();
    let ingress = ingress_peer(&pki, TRUSTED_LISTENER);
    let now = Utc::now();
    let expired = pki.originating_int.issue_with(
        &LeafSpec::client(vec![SanEntry::Dns("old.example.test".into())])
            .valid_between(now - Duration::days(2), now - Duration::days(1)),
    );
    assert_eq!(
        code(verify_originating(
            &chain_for(&expired, &pki),
            &pki.originating_trust(),
            &ingress,
            now,
            TRUSTED_LISTENER
        )),
        "evidence_expired"
    );

    let server_only = pki
        .originating_int
        .issue_with(&LeafSpec::server("not-a-client.example.test"));
    assert_eq!(
        code(verify_originating(
            &chain_for(&server_only, &pki),
            &pki.originating_trust(),
            &ingress,
            now,
            TRUSTED_LISTENER
        )),
        "forwarded_evidence_unverified"
    );

    // Revocation is checked chain-deep with unknown status denied, so every
    // issuer in the path must publish a CRL: the root's (covering the
    // intermediate) and the intermediate's (listing alice).
    let mut crls = pki.originating_root.crl_pem(&[]);
    crls.extend_from_slice(&pki.originating_int.crl_pem(&[&pki.alice]));
    let revoked_bundle = pki.originating_trust().with_crls(&crls).expect("crl");
    assert_eq!(
        code(verify_originating(
            &chain_for(&pki.alice, &pki),
            &revoked_bundle,
            &ingress,
            now,
            TRUSTED_LISTENER
        )),
        "evidence_revoked"
    );
    assert_eq!(
        code(verify_originating(
            &chain_for(&pki.bob, &pki),
            &revoked_bundle,
            &ingress,
            now,
            TRUSTED_LISTENER
        )),
        "ok",
        "bob is not on the CRL"
    );
}

#[test]
fn refuses_evidence_whose_ingress_is_not_a_trusted_ingress_peer() {
    let pki = Pki::new();
    let now = Utc::now();
    let chain = chain_for(&pki.alice, &pki);
    let trust = pki.originating_trust();

    let other_listener = ingress_peer(&pki, "host-other");
    assert_eq!(
        code(verify_originating(
            &chain,
            &trust,
            &other_listener,
            now,
            TRUSTED_LISTENER
        )),
        "listener_policy_mismatch"
    );

    let mut direct = AttestedPeer {
        source: EvidenceSource::DirectTls,
        identities: vec![],
        leaf_thumbprint_sha256: pki.stranger.thumbprint.clone(),
        not_before: now - Duration::minutes(5),
        not_after: now + Duration::hours(1),
        trust_profile: Pki::ingress_profile(),
        trust_generation: 1,
        credential_generation: 1,
        listener: TRUSTED_LISTENER.to_owned(),
        policy: TransportPolicy::MtlsRequired,
        tls_version: TlsVersion::Tls13,
        authenticated_at: now,
        usable_until: now + Duration::minutes(5),
        ingress: None,
    };
    let mtls_peer = direct.clone().into_verified().expect("mtls peer");
    assert_eq!(
        code(verify_originating(
            &chain,
            &trust,
            &mtls_peer,
            now,
            TRUSTED_LISTENER
        )),
        "listener_policy_mismatch"
    );

    direct.policy = TransportPolicy::TrustedIngress;
    direct.usable_until = now + Duration::seconds(1);
    let stale = direct.into_verified().expect("peer");
    assert_eq!(
        code(verify_originating(
            &chain,
            &trust,
            &stale,
            now + Duration::seconds(2),
            TRUSTED_LISTENER
        )),
        "evidence_expired",
        "an ingress past its usable bound cannot vouch for anyone"
    );
}

fn spiffe_ingress_peer(pki: &Pki) -> VerifiedPeer {
    AttestedPeer {
        source: EvidenceSource::DirectTls,
        identities: vec![PeerIdentitySelector::SpiffeId(
            "spiffe://example.test/ingress".into(),
        )],
        leaf_thumbprint_sha256: pki.ingress.thumbprint.clone(),
        not_before: Utc::now() - Duration::minutes(5),
        not_after: Utc::now() + Duration::hours(1),
        trust_profile: Pki::ingress_profile(),
        trust_generation: 1,
        credential_generation: 1,
        listener: TRUSTED_LISTENER.to_owned(),
        policy: TransportPolicy::TrustedIngress,
        tls_version: TlsVersion::Tls13,
        authenticated_at: Utc::now(),
        usable_until: Utc::now() + Duration::minutes(5),
        ingress: None,
    }
    .into_verified_spiffe()
    .unwrap()
}

#[test]
fn spiffe_forwarding_preserves_ingress_policy_and_checks_origin_domain() {
    let pki = Pki::new();
    let peer = spiffe_ingress_peer(&pki);
    let trust = TrustBundle::from_pem(
        Pki::originating_profile(),
        TrustProfileKind::SpiffeTrustDomain,
        &pki.originating_root.ca_pem(),
    )
    .unwrap()
    .with_spiffe_trust_domain("example.test")
    .unwrap();
    let good = pki
        .originating_int
        .issue_spiffe("spiffe://example.test/alice");
    let verified = verify_originating(
        &chain_for(&good, &pki),
        &trust,
        &peer,
        Utc::now(),
        TRUSTED_LISTENER,
    )
    .unwrap();
    assert_eq!(
        verified.identities(),
        &[PeerIdentitySelector::SpiffeId(
            "spiffe://example.test/alice".into()
        )]
    );
    assert_eq!(verified.ingress().unwrap().identities(), peer.identities());
    let bad = pki
        .originating_int
        .issue_spiffe("spiffe://other.test/alice");
    assert!(verify_originating(
        &chain_for(&bad, &pki),
        &trust,
        &peer,
        Utc::now(),
        TRUSTED_LISTENER
    )
    .is_err());
    // Alice chains correctly but its client-only EKU is not a full X.509-SVID.
    assert!(verify_originating(
        &chain_for(&pki.alice, &pki),
        &trust,
        &peer,
        Utc::now(),
        TRUSTED_LISTENER
    )
    .is_err());
}

#[test]
fn spiffe_ingress_admission_checks_leaf_revocation_separately() {
    let pki = Pki::new();
    let peer = spiffe_ingress_peer(&pki);
    let bindings = pki.bindings();
    bindings.write().unwrap().bindings[0].peer =
        PeerIdentitySelector::SpiffeId("spiffe://example.test/ingress".into());
    let admission = BindingSetAdmission::new(Arc::clone(&bindings));
    assert!(admission.is_authorized_ingress(&peer));
    bindings.write().unwrap().bindings[0]
        .denied_thumbprints
        .push(pki.ingress.thumbprint.clone());
    assert!(!admission.is_authorized_ingress(&peer));
    let mut set = bindings.write().unwrap();
    set.bindings[0].denied_thumbprints.clear();
    set.bindings[0].peer =
        PeerIdentitySelector::LeafThumbprintSha256(pki.ingress.thumbprint.clone());
    drop(set);
    assert!(!admission.is_authorized_ingress(&peer));
}
