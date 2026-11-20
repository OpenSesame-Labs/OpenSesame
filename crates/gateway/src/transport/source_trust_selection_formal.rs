//! Compare Lean's finite selector vectors with the production selection function.
use std::collections::{BTreeMap, BTreeSet, HashSet};

use opensesame_domain::transport::{TransportError, TrustProfileKind, TrustProfileRef};
use opensesame_transport_security::testkit::DisposableCa;
use opensesame_transport_security::{SourceTrust, TrustBundle};

use super::select;

fn bit(input: &str) -> bool {
    match input {
        "0" => false,
        "1" => true,
        _ => panic!("invalid selector vector bit"),
    }
}

#[test]
#[ignore = "requires Lean vectors; run spec/formal/source-trust-selection/verify.sh"]
fn lean_vectors_match_source_trust_selection() {
    let path =
        std::env::var("OPENSESAME_SOURCE_SELECTION_VECTORS").expect("run the formal verifier");
    let vectors = std::fs::read_to_string(path).expect("read source-selection vectors");
    let ca = DisposableCa::new("source-selection-vectors");
    let selected = TrustProfileRef::new("selected.test").unwrap();
    let other = TrustProfileRef::new("other.test").unwrap();
    let mut seen = HashSet::new();
    assert!(matches!(
        select(Ok(None), &selected),
        Err(TransportError::TrustUnknown)
    ));
    for line in vectors.lines() {
        let fields: Vec<_> = line.split('\t').collect();
        let ["source", fresh, present, kind, label, expected] = fields.as_slice() else {
            panic!("invalid selector vector: {line}");
        };
        let (fresh, present, kind, label, expected) = (
            bit(fresh),
            bit(present),
            bit(kind),
            bit(label),
            bit(expected),
        );
        assert!(
            seen.insert((fresh, present, kind, label)),
            "duplicate selector input"
        );
        let mut bundles = BTreeMap::new();
        if present {
            let bundle = TrustBundle::from_pem(
                if label {
                    selected.clone()
                } else {
                    other.clone()
                },
                if kind {
                    TrustProfileKind::SpiffeTrustDomain
                } else {
                    TrustProfileKind::PrivateRoot
                },
                &ca.root_pem(),
            )
            .unwrap();
            bundles.insert(selected.clone(), bundle);
        }
        let view = if fresh {
            Ok(Some(SourceTrust {
                bundles,
                reserved: BTreeSet::new(),
            }))
        } else {
            Err(TransportError::GenerationStale)
        };
        let actual = select(view, &selected);
        assert_eq!(actual.is_ok(), expected, "selector vector {line}");
        if !fresh {
            assert!(matches!(actual, Err(TransportError::GenerationStale)));
        } else if !expected {
            assert!(matches!(actual, Err(TransportError::TrustUnknown)));
        }
    }
    assert_eq!(seen.len(), 16, "incomplete selector vector matrix");
}

#[test]
fn returns_exact_requested_source_bundle() {
    let requested = TrustProfileRef::new("z-selected.test").unwrap();
    let earlier = TrustProfileRef::new("a-other.test").unwrap();
    let selected_ca = DisposableCa::new("requested-source");
    let earlier_ca = DisposableCa::new("earlier-source");
    let stored_ca = DisposableCa::new("stored-lookalike");
    let make_bundle = |profile, ca: &DisposableCa, generation| {
        TrustBundle::from_pem(profile, TrustProfileKind::SpiffeTrustDomain, &ca.root_pem())
            .unwrap()
            .with_crls(&ca.crl_pem(&[]))
            .unwrap()
            .with_generation(generation)
    };
    let source_bundle = make_bundle(requested.clone(), &selected_ca, 41);
    let earlier_bundle = make_bundle(earlier.clone(), &earlier_ca, 17);
    let stored_bundle = make_bundle(requested.clone(), &stored_ca, 99);
    assert_ne!(source_bundle.anchors(), stored_bundle.anchors());
    let view = SourceTrust {
        bundles: [
            (earlier.clone(), earlier_bundle.clone()),
            (requested.clone(), source_bundle.clone()),
        ]
        .into(),
        reserved: BTreeSet::new(),
    };
    let actual = select(Ok(Some(view)), &requested).unwrap();
    assert_eq!(actual.profile(), source_bundle.profile());
    assert_eq!(actual.kind(), source_bundle.kind());
    assert_eq!(actual.anchors(), source_bundle.anchors());
    assert_eq!(actual.crls(), source_bundle.crls());
    assert_eq!(actual.generation(), source_bundle.generation());
    let missing = SourceTrust {
        bundles: [(earlier, earlier_bundle)].into(),
        reserved: BTreeSet::new(),
    };
    assert!(matches!(
        select(Ok(Some(missing)), &requested),
        Err(TransportError::TrustUnknown)
    ));
}
