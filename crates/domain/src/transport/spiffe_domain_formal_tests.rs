//! Compare Lean's SPIFFE selector matrix with real service admission.
use std::collections::HashSet;

use super::binding_tests::{binding, now, set, spiffe, HEX_A};
use super::evidence_tests::attested;
use super::*;

fn bit(value: &str) -> bool {
    match value {
        "0" => false,
        "1" => true,
        _ => panic!("invalid formal selector bit"),
    }
}

#[test]
#[ignore = "requires Lean vectors; run the SPIFFE peer-domain verifier"]
fn lean_vectors_match_real_spiffe_service_admission() {
    let path = std::env::var("OPENSESAME_SPIFFE_PEER_VECTORS").expect("run the formal verifier");
    let vectors = std::fs::read_to_string(path).expect("read formal vectors");
    let mut seen = HashSet::new();
    for line in vectors.lines() {
        let fields: Vec<_> = line.split('\t').collect();
        let ["binding", kind, same, revoked, expected] = fields.as_slice() else {
            panic!("invalid formal selector vector: {line}");
        };
        let (same, revoked, expected) = (bit(same), bit(revoked), bit(expected));
        assert!(
            seen.insert((*kind, same, revoked)),
            "duplicate selector vector"
        );
        let selector = match *kind {
            "spiffe" if same => spiffe("ns/prod/sa/nats-bridge"),
            "spiffe" => spiffe("ns/prod/sa/different"),
            "dns" => PeerIdentitySelector::DnsName("peer.example".into()),
            "uri" => PeerIdentitySelector::UriSan("https://peer.example/identity".into()),
            "thumbprint" => PeerIdentitySelector::LeafThumbprintSha256(HEX_A.into()),
            _ => panic!("invalid formal selector kind"),
        };
        let peer = attested(EvidenceSource::DirectTls, TransportPolicy::MtlsRequired)
            .into_verified_spiffe()
            .unwrap();
        let mut candidate = binding("bridge", selector, BindingPurpose::NatsAuthBridge);
        if revoked {
            candidate.denied_thumbprints.push(HEX_A.into());
        }
        let admitted = ServiceCaller::admit(
            peer,
            &BindingScope::Deployment,
            &set(vec![candidate]),
            BindingPurpose::NatsAuthBridge,
            3,
            7,
            now(),
        );
        assert_eq!(admitted.is_ok(), expected, "selector vector {line}");
    }
    assert_eq!(seen.len(), 16, "incomplete formal selector matrix");
}
