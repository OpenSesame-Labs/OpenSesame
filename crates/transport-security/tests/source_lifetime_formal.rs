//! Compare Lean-generated source-lifetime cases with the real generation manager.

mod common;

use std::collections::HashSet;
use std::sync::Arc;

use opensesame_time::{Duration, Utc};
use opensesame_domain::TransportError;
use opensesame_transport_security::testkit::DisposableCa;
use opensesame_transport_security::{GenerationCandidate, SourceOwner, TransportGenerations};

type VectorCheck = fn(&[&str], &str);

fn manager() -> Arc<TransportGenerations> {
    let server = DisposableCa::new("formal-servers");
    let client = DisposableCa::new("formal-clients");
    common::generations(server.issue_server("localhost").identity(), &client)
}

fn candidate(manager: &TransportGenerations) -> GenerationCandidate {
    let current = manager.current();
    GenerationCandidate {
        identity: current.identity.clone(),
        peer_trust: current.peer_trust.clone(),
        own_trust: None,
        identity_required: true,
    }
}

fn active() -> (Arc<TransportGenerations>, SourceOwner, u64) {
    let manager = manager();
    let owner = manager.source_owner();
    let reserved = manager.claim_source(&owner).unwrap();
    assert_eq!(reserved, 2);
    let epoch = manager
        .activate_from_source(&owner, reserved, candidate(&manager))
        .unwrap();
    assert_eq!(epoch, 3);
    (manager, owner, epoch)
}

fn bit(value: bool) -> &'static str {
    if value {
        "1"
    } else {
        "0"
    }
}

fn parse_bit(value: &str) -> bool {
    match value {
        "0" => false,
        "1" => true,
        _ => panic!("invalid vector bit: {value}"),
    }
}

fn parse_number(value: &str) -> i64 {
    let number: i64 = value.parse().expect("invalid vector integer");
    assert_eq!(number.to_string(), value, "noncanonical vector integer");
    number
}

fn check_claim(fields: &[&str], line: &str) {
    let manager = manager();
    let owner = manager.source_owner();
    assert_eq!(manager.claim_source(&owner).unwrap(), 2);
    assert_eq!(
        bit(manager.current().withdrawn.is_some()),
        fields[1],
        "{line}"
    );
    assert_eq!(
        bit(manager.checked_current_at(None, Utc::now()).is_ok()),
        fields[2],
        "{line}"
    );
}

fn check_fence(fields: &[&str], line: &str) {
    let owner_number = parse_number(fields[1]);
    let epoch_number = u64::try_from(parse_number(fields[2])).unwrap();
    assert!([1, 2].contains(&owner_number));
    assert!([2, 3].contains(&epoch_number));

    let (manager, correct, _) = active();
    let other = manager.source_owner();
    let selected = if owner_number == 1 { &correct } else { &other };
    let changed = manager
        .tighten_source_deadline(selected, epoch_number, Utc::now() + Duration::minutes(5))
        .is_ok();
    assert_eq!(bit(changed), fields[3], "{line}");

    let (manager, correct, _) = active();
    let other = manager.source_owner();
    let selected = if owner_number == 1 { &correct } else { &other };
    let _ = manager.withdraw_from_source(selected, epoch_number, TransportError::IdentityMissing);
    assert_eq!(
        bit(manager.current().withdrawn.is_some()),
        fields[4],
        "{line}"
    );
    assert_eq!(manager.current().number.to_string(), fields[5], "{line}");

    let (manager, correct, _) = active();
    let other = manager.source_owner();
    let selected = if owner_number == 1 { &correct } else { &other };
    let _ = manager.retire_source(selected, epoch_number);
    assert_eq!(
        bit(manager.current().withdrawn.is_some()),
        fields[6],
        "{line}"
    );
    assert_eq!(manager.current().number.to_string(), fields[7], "{line}");
}

fn check_usable(fields: &[&str], line: &str) {
    let deadline = parse_number(fields[1]);
    let now = parse_number(fields[2]);
    assert!([1, 5, 10].contains(&deadline));
    assert!([0, 1, 5, 10].contains(&now));
    let (manager, owner, epoch) = active();
    let start = Utc::now();
    manager
        .tighten_source_deadline(&owner, epoch, start + Duration::minutes(deadline))
        .unwrap();
    let actual = manager
        .checked_current_at(None, start + Duration::minutes(now))
        .is_ok();
    assert_eq!(bit(actual), fields[3], "{line}");
}

fn check_ordinary(fields: &[&str], line: &str) {
    let same_identity = parse_bit(fields[1]);
    let same_trust = parse_bit(fields[2]);
    let now = parse_number(fields[3]);
    assert!([5, 10].contains(&now));
    let (manager, owner, epoch) = active();
    let mut proposed = candidate(&manager);
    if !same_identity {
        let other = DisposableCa::new("other-identity");
        proposed.identity = Some(Arc::new(other.issue_server("localhost").identity()));
    }
    if !same_trust {
        let key = proposed.peer_trust.keys().next().unwrap().clone();
        proposed.peer_trust.remove(&key);
    }
    let deadline = Utc::now() + Duration::minutes(if now == 5 { 1 } else { -1 });
    manager
        .tighten_source_deadline(&owner, epoch, deadline)
        .unwrap();
    let _ = manager.activate(proposed);
    assert_eq!(manager.current().number.to_string(), fields[4], "{line}");
    assert_eq!(
        bit(manager.source_expired_latched().unwrap().unwrap()),
        fields[5],
        "{line}"
    );
}

#[test]
#[ignore = "requires Lean vectors; run spec/formal/source-lifetime/verify.sh"]
fn lean_vectors_match_source_owned_generation_manager() {
    let path = std::env::var("OPENSESAME_SOURCE_LIFETIME_VECTORS")
        .expect("run the source-lifetime formal verification script");
    let input = std::fs::read_to_string(path).expect("read Lean source-lifetime vectors");
    let mut seen = HashSet::new();
    let mut inputs = HashSet::new();
    let mut counts = [0_u32; 4];
    for line in input.lines() {
        assert!(seen.insert(line.to_owned()), "duplicate vector: {line}");
        let fields: Vec<_> = line.split('\t').collect();
        let (index, key_length, check): (usize, usize, VectorCheck) = match fields.as_slice() {
            ["claim", _, _] => (0, 1, check_claim),
            ["fence", _, _, _, _, _, _, _] => (1, 3, check_fence),
            ["usable", _, _, _] => (2, 3, check_usable),
            ["ordinary", _, _, _, _, _] => (3, 4, check_ordinary),
            _ => panic!("unexpected source-lifetime vector: {line}"),
        };
        assert!(
            inputs.insert(fields[..key_length].join("/")),
            "duplicate input: {line}"
        );
        counts[index] += 1;
        check(&fields, line);
    }
    assert_eq!(counts, [1, 4, 12, 8], "incomplete Lean vector matrix");
}
