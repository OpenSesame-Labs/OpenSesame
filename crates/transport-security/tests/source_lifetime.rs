//! Source-owned expiry is enforced at use, even if its timer has not run.

mod common;

use std::sync::{Arc, Barrier};

use chrono::{Duration, Utc};
use common::*;
use opensesame_domain::transport::{
    PeerIdentitySelector, TlsVersion, TransportError, TransportPolicy,
};
use opensesame_transport_security::testkit::DisposableCa;
use opensesame_transport_security::{
    client_config, ClientProfile, GenerationCandidate, ServerNamePolicy, SourceOwner,
    TransportGenerations,
};

fn candidate(generations: &TransportGenerations) -> GenerationCandidate {
    let current = generations.current();
    GenerationCandidate {
        identity: current.identity.clone(),
        peer_trust: current.peer_trust.clone(),
        own_trust: None,
        identity_required: true,
    }
}

fn manager() -> Arc<TransportGenerations> {
    let server = DisposableCa::new("servers");
    let client = DisposableCa::new("clients");
    generations(server.issue_server("localhost").identity(), &client)
}

fn claim_and_activate(gens: &TransportGenerations, owner: &SourceOwner) -> u64 {
    let reserved = gens.claim_source(owner).unwrap();
    gens.activate_from_source(owner, reserved, candidate(gens))
        .unwrap()
}

#[test]
fn claiming_quarantines_a_populated_manager_until_an_owned_activation() {
    let gens = manager();
    let previous = candidate(&gens);
    let owner = gens.source_owner();
    let reserved = gens.claim_source(&owner).unwrap();
    assert!(matches!(
        gens.checked_current_at(None, Utc::now()),
        Err(TransportError::SourceUnsupported)
    ));
    assert!(gens.activate(previous.clone()).is_err());
    let epoch = gens
        .activate_from_source(&owner, reserved, previous.clone())
        .unwrap();
    assert!(gens.checked_current_at(Some(epoch), Utc::now()).is_ok());
    gens.retire_source(&owner, epoch).unwrap();
    assert!(gens.activate(previous.clone()).is_err());
    assert!(gens.checked_current_at(None, Utc::now()).is_err());
    let next = gens.source_owner();
    let reserved = gens.claim_source(&next).unwrap();
    let epoch = gens
        .activate_from_source(&next, reserved, previous)
        .unwrap();
    assert!(gens.checked_current_at(Some(epoch), Utc::now()).is_ok());
}

#[test]
fn expiry_is_inclusive_latched_and_reset_only_by_a_fresh_source_activation() {
    let gens = manager();
    let owner = gens.source_owner();
    let epoch = claim_and_activate(&gens, &owner);
    let deadline = Utc::now() + Duration::minutes(1);
    gens.tighten_source_deadline(&owner, epoch, deadline)
        .unwrap();
    assert!(gens
        .checked_current_at(None, deadline - Duration::nanoseconds(1))
        .is_ok());
    assert!(matches!(
        gens.checked_current_at(None, deadline),
        Err(TransportError::EvidenceExpired)
    ));
    assert!(matches!(
        gens.checked_current_at(None, deadline - Duration::minutes(1)),
        Err(TransportError::EvidenceExpired)
    ));
    assert!(matches!(
        gens.activate_if_current(gens.current().number, candidate(&gens)),
        Err(TransportError::EvidenceExpired)
    ));
    gens.activate_from_source(&owner, epoch, candidate(&gens))
        .unwrap();
    assert!(gens.checked_current_at(None, Utc::now()).is_ok());
}

#[test]
fn source_epoch_survives_trust_updates_and_delayed_events_cannot_change_a_new_epoch() {
    let gens = manager();
    let owner = gens.source_owner();
    let old = claim_and_activate(&gens, &owner);
    let trust_update = gens
        .activate_if_current(gens.current().number, candidate(&gens))
        .unwrap();
    assert_ne!(old, trust_update);
    let bound = Utc::now() + Duration::minutes(1);
    gens.tighten_source_deadline(&owner, old, bound).unwrap();
    let fresh = gens
        .activate_from_source(&owner, old, candidate(&gens))
        .unwrap();
    assert!(fresh > trust_update);
    assert_eq!(
        gens.tighten_source_deadline(&owner, old, Utc::now() - Duration::seconds(1)),
        Err(TransportError::GenerationStale)
    );
    assert_eq!(
        gens.withdraw_from_source(&owner, old, TransportError::IdentityMissing),
        Err(TransportError::GenerationStale)
    );
    assert!(gens.checked_current_at(Some(fresh), Utc::now()).is_ok());
}

#[test]
fn ordinary_updates_cannot_shadow_or_remove_source_owned_trust() {
    let gens = manager();
    let owner = gens.source_owner();
    let epoch = claim_and_activate(&gens, &owner);
    let original = candidate(&gens);
    let profile = original.peer_trust.keys().next().unwrap().clone();
    let mut removed = original.clone();
    removed.peer_trust.remove(&profile);
    assert_eq!(gens.activate(removed), Err(TransportError::GenerationStale));
    let other = DisposableCa::new("shadowing");
    let original_bundle = original.peer_trust.get(&profile).unwrap();
    let replacement = opensesame_transport_security::TrustBundle::from_pem(
        profile.clone(),
        original_bundle.kind(),
        &other.root_pem(),
    )
    .unwrap();
    let mut changed = original.clone();
    changed.peer_trust.insert(profile, replacement);
    assert_eq!(gens.activate(changed), Err(TransportError::GenerationStale));
    assert!(gens.activate(original).is_ok());
    assert!(gens
        .tighten_source_deadline(&owner, epoch, Utc::now() + Duration::seconds(30))
        .is_ok());
}

#[test]
fn owner_handoff_invalidates_old_owners_and_unrelated_managers() {
    let gens = manager();
    let old_owner = gens.source_owner();
    let early_owner = gens.source_owner();
    let old = claim_and_activate(&gens, &old_owner);
    assert_eq!(
        gens.claim_source(&early_owner),
        Err(TransportError::GenerationStale)
    );
    gens.retire_source(&old_owner, old).unwrap();
    let new_owner = gens.source_owner();
    let new = claim_and_activate(&gens, &new_owner);
    assert_eq!(
        gens.activate_from_source(&old_owner, old, candidate(&gens)),
        Err(TransportError::GenerationStale)
    );
    assert_eq!(
        gens.tighten_source_deadline(&old_owner, old, Utc::now()),
        Err(TransportError::GenerationStale)
    );
    let other = manager();
    assert_eq!(
        other.activate_from_source(&new_owner, new, candidate(&other)),
        Err(TransportError::GenerationStale)
    );
    assert!(gens.checked_current_at(Some(new), Utc::now()).is_ok());
}

#[test]
fn concurrent_old_tightening_cannot_expire_a_new_source_epoch() {
    for _ in 0..24 {
        let gens = manager();
        let owner = gens.source_owner();
        let old = claim_and_activate(&gens, &owner);
        let barrier = Arc::new(Barrier::new(3));
        let next_candidate = candidate(&gens);
        let new_gen = Arc::clone(&gens);
        let new_owner = owner.clone();
        let new_barrier = Arc::clone(&barrier);
        let activate = std::thread::spawn(move || {
            new_barrier.wait();
            new_gen.activate_from_source(&new_owner, old, next_candidate)
        });
        let old_gen = Arc::clone(&gens);
        let old_owner = owner.clone();
        let old_barrier = Arc::clone(&barrier);
        let tighten = std::thread::spawn(move || {
            old_barrier.wait();
            old_gen.tighten_source_deadline(&old_owner, old, Utc::now() - Duration::seconds(1))
        });
        barrier.wait();
        let fresh = activate.join().unwrap().unwrap();
        let result = tighten.join().unwrap();
        assert!(result.is_ok() || result == Err(TransportError::GenerationStale));
        assert!(gens.checked_current_at(Some(fresh), Utc::now()).is_ok());
    }
}

#[test]
fn a_missing_peer_does_not_bypass_an_expired_source_deadline() {
    let gens = manager();
    let owner = gens.source_owner();
    let epoch = claim_and_activate(&gens, &owner);
    gens.tighten_source_deadline(&owner, epoch, Utc::now() - Duration::seconds(1))
        .unwrap();
    let request = axum::extract::Request::new(axum::body::Body::empty());
    assert_eq!(
        opensesame_transport_security::guard::check_peer_freshness(&gens, &request),
        Err(TransportError::EvidenceExpired)
    );
    assert!(
        gens.current().withdrawn.is_none(),
        "the timer did not withdraw it"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn source_claim_quarantines_existing_connections_before_any_snapshot() {
    let server = DisposableCa::new("servers");
    let client = DisposableCa::new("clients");
    let gens = generations(server.issue_server("localhost").identity(), &client);
    let previous = candidate(&gens);
    let hits = Hits::default();
    let listener = serve(
        Arc::clone(&gens),
        profile_fn(TransportPolicy::MtlsRequired),
        router(Arc::clone(&gens), hits.clone()),
    )
    .await;
    let leaf = client.issue_client(PeerIdentitySelector::DnsName("peer.internal".into()));
    let config = Arc::new(
        client_config(&ClientProfile {
            server_trust: private_root("servers", &server),
            server_name: ServerNamePolicy::Dns("localhost".into()),
            identity: Some(Arc::new(leaf.identity())),
            min_version: TlsVersion::Tls13,
        })
        .unwrap(),
    );
    let mut existing = connect(Arc::clone(&config), listener.addr, localhost())
        .await
        .unwrap();
    assert_eq!(
        request_on(&mut existing, "/protected").await.unwrap().0,
        200
    );
    let owner = gens.source_owner();
    let reserved = gens.claim_source(&owner).unwrap();
    let (status, _) = request_on(&mut existing, "/protected").await.unwrap();
    assert_eq!(status, 403);
    assert!(connect(Arc::clone(&config), listener.addr, localhost())
        .await
        .is_err());
    assert!(gens.activate(previous.clone()).is_err());
    assert_eq!(hits.protected(), 1);
    gens.activate_from_source(&owner, reserved, previous)
        .unwrap();
    assert_eq!(
        raw_get(config, listener.addr, localhost(), "/protected")
            .await
            .unwrap()
            .0,
        200
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_expired_source_blocks_new_handshakes_and_existing_requests() {
    let server = DisposableCa::new("servers");
    let client = DisposableCa::new("clients");
    let gens = generations(server.issue_server("localhost").identity(), &client);
    let owner = gens.source_owner();
    let epoch = claim_and_activate(&gens, &owner);
    let hits = Hits::default();
    let listener = serve(
        Arc::clone(&gens),
        profile_fn(TransportPolicy::MtlsRequired),
        router(Arc::clone(&gens), hits.clone()),
    )
    .await;
    let leaf = client.issue_client(PeerIdentitySelector::DnsName("peer.internal".into()));
    let client_config = Arc::new(
        client_config(&ClientProfile {
            server_trust: private_root("servers", &server),
            server_name: ServerNamePolicy::Dns("localhost".into()),
            identity: Some(Arc::new(leaf.identity())),
            min_version: TlsVersion::Tls13,
        })
        .unwrap(),
    );
    let mut existing = connect(Arc::clone(&client_config), listener.addr, localhost())
        .await
        .unwrap();
    assert_eq!(
        request_on(&mut existing, "/protected").await.unwrap().0,
        200
    );
    gens.tighten_source_deadline(&owner, epoch, Utc::now() - Duration::seconds(1))
        .unwrap();
    assert!(gens.current().withdrawn.is_none());
    let (status, body) = request_on(&mut existing, "/protected").await.unwrap();
    assert_eq!(status, 403);
    assert!(body.contains("evidence_expired"));
    assert!(connect(client_config, listener.addr, localhost())
        .await
        .is_err());
    assert_eq!(hits.protected(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handshake_started_before_expiry_is_rechecked_after_tls_completes() {
    let server = DisposableCa::new("servers");
    let client = DisposableCa::new("clients");
    let gens = generations(server.issue_server("localhost").identity(), &client);
    let owner = gens.source_owner();
    let epoch = claim_and_activate(&gens, &owner);
    let hits = Hits::default();
    let listener = serve(
        Arc::clone(&gens),
        profile_fn(TransportPolicy::MtlsRequired),
        router(Arc::clone(&gens), hits.clone()),
    )
    .await;
    let tcp = tokio::net::TcpStream::connect(listener.addr).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while listener.counters.handshakes_started() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("listener accepted the connection before expiry");
    gens.tighten_source_deadline(&owner, epoch, Utc::now() - Duration::seconds(1))
        .unwrap();
    let leaf = client.issue_client(PeerIdentitySelector::DnsName("peer.internal".into()));
    let config = Arc::new(
        client_config(&ClientProfile {
            server_trust: private_root("servers", &server),
            server_name: ServerNamePolicy::Dns("localhost".into()),
            identity: Some(Arc::new(leaf.identity())),
            min_version: TlsVersion::Tls13,
        })
        .unwrap(),
    );
    let connection = tokio_rustls::TlsConnector::from(config)
        .connect(localhost(), tcp)
        .await;
    if let Ok(mut stream) = connection {
        assert!(request_on(&mut stream, "/protected").await.is_err());
    }
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while listener.counters.handshakes_failed() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("server must reject after the handshake");
    assert_eq!(hits.protected(), 0);
}
