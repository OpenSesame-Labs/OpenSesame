//! Real-manager tests for preserving a seeded source reservation through an
//! identity-source transition. The Host integration remains under review.
mod common;

use std::collections::BTreeSet;
use std::time::{Duration, Instant};

use common::{generations, private_root, profile_ref, CLIENTS};
use opensesame_domain::transport::TransportError;
use opensesame_time::Utc;
use opensesame_transport_security::testkit::DisposableCa;
use opensesame_transport_security::{GenerationCandidate, TransportGenerations};

fn candidate(generations: &TransportGenerations) -> GenerationCandidate {
    let current = generations.current();
    GenerationCandidate {
        identity: current.identity.clone(),
        peer_trust: current.peer_trust.clone(),
        own_trust: None,
        identity_required: current.identity.is_some(),
    }
}

#[test]
fn seeded_history_blocks_old_source_names_without_blocking_unrelated_local_trust() {
    let server = DisposableCa::new("server");
    let clients = DisposableCa::new("clients");
    let local = DisposableCa::new("local");
    let manager = generations(server.issue_server("localhost").identity(), &clients);
    let reserved = BTreeSet::from([profile_ref("old-source.test")]);
    manager.seed_source_history(1, &reserved).unwrap();
    let provenance = manager.source_trust(1).unwrap().unwrap();
    assert_eq!(provenance.reserved, reserved);
    assert!(provenance.bundles.is_empty());

    let mut colliding = candidate(&manager);
    colliding.peer_trust.insert(
        profile_ref("old-source.test"),
        private_root("old-source.test", &local),
    );
    assert_eq!(
        manager.activate(colliding),
        Err(TransportError::GenerationStale)
    );
    assert_eq!(manager.current().number, 1);
    let mut unrelated = candidate(&manager);
    unrelated.peer_trust.insert(
        profile_ref("local.test"),
        private_root("local.test", &local),
    );
    let number = manager.activate(unrelated).unwrap();
    assert!(manager
        .current()
        .peer_trust
        .contains_key(&profile_ref("local.test")));
    assert_eq!(
        manager.source_trust(number).unwrap().unwrap().reserved,
        reserved
    );
}

#[test]
fn seed_refuses_existing_collisions_and_generation_races() {
    let server = DisposableCa::new("server");
    let clients = DisposableCa::new("clients");
    let manager = generations(server.issue_server("localhost").identity(), &clients);
    assert_eq!(
        manager.seed_source_history(1, &BTreeSet::from([profile_ref(CLIENTS)])),
        Err(TransportError::GenerationStale)
    );
    assert!(manager.source_trust(1).unwrap().is_none());
    manager.activate(candidate(&manager)).unwrap();
    assert_eq!(
        manager.seed_source_history(1, &BTreeSet::from([profile_ref("old.test")])),
        Err(TransportError::GenerationStale)
    );
    assert!(manager.source_trust(2).unwrap().is_none());
}

#[test]
fn source_claim_preserves_seeded_history_and_can_authoritatively_replace_it() {
    let server = DisposableCa::new("server");
    let clients = DisposableCa::new("clients");
    let manager = generations(server.issue_server("localhost").identity(), &clients);
    let reserved = BTreeSet::from([profile_ref("old.test")]);
    manager.seed_source_history(1, &reserved).unwrap();
    let owner = manager.source_owner();
    let epoch = manager.claim_source(&owner).unwrap();
    let mut source = candidate(&manager);
    source
        .peer_trust
        .insert(profile_ref("old.test"), private_root("old.test", &clients));
    let active = manager.activate_from_source(&owner, epoch, source).unwrap();
    let provenance = manager.source_trust(active).unwrap().unwrap();
    assert!(provenance.reserved.contains(&profile_ref("old.test")));
    assert!(provenance.bundles.contains_key(&profile_ref("old.test")));
}

#[test]
fn source_publication_refuses_elapsed_wait_bounds_and_stale_epochs() {
    let server = DisposableCa::new("server");
    let clients = DisposableCa::new("clients");
    let manager = generations(server.issue_server("localhost").identity(), &clients);
    let owner = manager.source_owner();
    let epoch = manager.claim_source(&owner).unwrap();
    let proposed = candidate(&manager);
    let wall = Utc::now();
    let mono = Instant::now();
    let deadline = wall + opensesame_time::Duration::minutes(1);
    let mono_deadline = mono + Duration::from_mins(1);
    assert_eq!(
        manager.activate_from_source_before_at(
            &owner,
            epoch,
            proposed.clone(),
            deadline,
            mono_deadline,
            (deadline, mono),
        ),
        Err(TransportError::EvidenceExpired)
    );
    assert_eq!(
        manager.activate_from_source_before_at(
            &owner,
            epoch,
            proposed.clone(),
            deadline,
            mono_deadline,
            (wall, mono_deadline),
        ),
        Err(TransportError::EvidenceExpired)
    );
    assert!(manager.checked_current(None).is_err());
    let active = manager
        .activate_from_source_before_at(
            &owner,
            epoch,
            proposed.clone(),
            deadline,
            mono_deadline,
            (wall, mono),
        )
        .unwrap();
    assert!(manager.checked_current(Some(active)).is_ok());
    assert_eq!(
        manager.activate_from_source_before_at(
            &owner,
            epoch,
            proposed,
            deadline,
            mono_deadline,
            (wall, mono),
        ),
        Err(TransportError::GenerationStale)
    );
    assert_eq!(manager.current().number, active);
}

#[test]
fn pending_names_survive_same_manager_owner_handoff() {
    let server = DisposableCa::new("server");
    let clients = DisposableCa::new("clients");
    let stored = DisposableCa::new("stored");
    let manager = generations(server.issue_server("localhost").identity(), &clients);
    let old = manager.source_owner();
    let claimed = manager.claim_source(&old).unwrap();
    let active = manager
        .activate_from_source(&old, claimed, candidate(&manager))
        .unwrap();
    let pending = BTreeSet::from([profile_ref("new-source.test")]);
    assert!(!manager
        .reserve_pending_source_names(&old, active, &pending)
        .unwrap());
    // Simulate a canceled write that may already have committed. No later
    // activation from the old owner is needed to preserve the reservation.
    manager.retire_source(&old, active).unwrap();
    let next = manager.source_owner();
    let next_claimed = manager.claim_source(&next).unwrap();
    let next_active = manager
        .activate_from_source(&next, next_claimed, candidate(&manager))
        .unwrap();
    let mut local = candidate(&manager);
    local.peer_trust.insert(
        profile_ref("new-source.test"),
        private_root("new-source.test", &stored),
    );
    assert_eq!(
        manager.activate(local),
        Err(TransportError::GenerationStale)
    );
    assert!(manager
        .source_trust(next_active)
        .unwrap()
        .unwrap()
        .reserved
        .contains(&profile_ref("new-source.test")));
    assert_eq!(
        manager.reserve_pending_source_names(&old, active, &pending),
        Err(TransportError::GenerationStale)
    );
}

#[test]
fn pending_source_name_withdraws_colliding_local_trust_before_storage() {
    let server = DisposableCa::new("server");
    let clients = DisposableCa::new("clients");
    let stored = DisposableCa::new("stored");
    let manager = generations(server.issue_server("localhost").identity(), &clients);
    let owner = manager.source_owner();
    let claimed = manager.claim_source(&owner).unwrap();
    let active = manager
        .activate_from_source(&owner, claimed, candidate(&manager))
        .unwrap();
    let mut local = candidate(&manager);
    local.peer_trust.insert(
        profile_ref("new-source.test"),
        private_root("new-source.test", &stored),
    );
    manager.activate(local).unwrap();
    assert!(manager.checked_current(None).is_ok());
    assert!(manager
        .reserve_pending_source_names(
            &owner,
            active,
            &BTreeSet::from([profile_ref("new-source.test")]),
        )
        .unwrap());
    assert!(manager.checked_current(None).is_err());
    let current = manager.current();
    assert!(manager
        .source_trust(current.number)
        .unwrap()
        .unwrap()
        .reserved
        .contains(&profile_ref("new-source.test")));
}

#[test]
fn independent_tightening_cannot_be_undone_by_source_finalization() {
    let server = DisposableCa::new("server");
    let clients = DisposableCa::new("clients");
    let manager = generations(server.issue_server("localhost").identity(), &clients);
    let owner = manager.source_owner();
    let claimed = manager.claim_source(&owner).unwrap();
    let wall = Utc::now();
    let mono = Instant::now();
    let wall_bound = wall + opensesame_time::Duration::minutes(1);
    let mono_bound = mono + Duration::from_mins(1);
    let provisional = manager
        .activate_from_source_before_at(
            &owner,
            claimed,
            candidate(&manager),
            wall_bound,
            mono_bound,
            (wall, mono),
        )
        .unwrap();
    // Even a request equal to the provisional bound records an independent
    // restriction and must not be undone by a later finalization.
    manager
        .tighten_source_deadline_bounded(&owner, provisional, wall_bound, mono_bound)
        .unwrap();
    assert_eq!(
        manager.finalize_source_activation(&owner, provisional),
        Err(TransportError::GenerationStale)
    );
    assert!(matches!(
        manager.checked_current_at(None, wall_bound),
        Err(TransportError::EvidenceExpired)
    ));
}
