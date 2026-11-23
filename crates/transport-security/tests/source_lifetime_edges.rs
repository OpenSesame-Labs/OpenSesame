//! Runtime tests for source-owned trust and TLS-only connection epochs.
mod common;
use common::*;
use opensesame_domain::transport::{TlsVersion, TransportError, TransportPolicy};
use opensesame_time::Utc;
use opensesame_transport_security::testkit::DisposableCa;
use opensesame_transport_security::{
    client_config, ClientProfile, GenerationCandidate, SecureListener, ServerNamePolicy,
    ServerProfile, SourceOwner, TransportGenerations, TrustBundle,
};
use std::sync::Arc;

fn candidate(gens: &TransportGenerations) -> GenerationCandidate {
    let current = gens.current();
    GenerationCandidate {
        identity: current.identity.clone(),
        peer_trust: current.peer_trust.clone(),
        own_trust: None,
        identity_required: true,
    }
}

fn assert_source_trust_is_immutable(
    gens: &TransportGenerations,
    owner: &SourceOwner,
    active: u64,
    source: &GenerationCandidate,
    source_b: &DisposableCa,
    stored_b: &DisposableCa,
) -> GenerationCandidate {
    let profile_b = profile_ref("federated.test");
    let authoritative = source.peer_trust.get(&profile_b).unwrap();
    let generation = gens.current().number;
    let mut replacement = (*source).clone();
    replacement
        .peer_trust
        .insert(profile_b.clone(), spiffe_bundle("federated.test", stored_b));
    assert_eq!(
        gens.activate(replacement),
        Err(TransportError::GenerationStale)
    );
    let mut missing = (*source).clone();
    missing.peer_trust.remove(&profile_b);
    assert_eq!(
        gens.activate(missing.clone()),
        Err(TransportError::GenerationStale)
    );
    let mut wrong_label = (*source).clone();
    wrong_label
        .peer_trust
        .insert(profile_b.clone(), spiffe_bundle("different.test", source_b));
    assert_eq!(
        gens.activate(wrong_label.clone()),
        Err(TransportError::GenerationStale)
    );
    assert_eq!(
        gens.activate_from_source(owner, active, wrong_label),
        Err(TransportError::GenerationStale)
    );
    let mut added = (*source).clone();
    let mut anchors = authoritative.anchors().to_vec();
    anchors.extend(
        spiffe_bundle("federated.test", stored_b)
            .anchors()
            .iter()
            .cloned(),
    );
    added.peer_trust.insert(
        profile_b.clone(),
        TrustBundle::from_der(profile_b.clone(), authoritative.kind(), anchors).unwrap(),
    );
    assert_eq!(gens.activate(added), Err(TransportError::GenerationStale));
    let mut changed_kind = (*source).clone();
    changed_kind
        .peer_trust
        .insert(profile_b.clone(), private_root("federated.test", source_b));
    assert_eq!(
        gens.activate(changed_kind),
        Err(TransportError::GenerationStale)
    );
    let mut changed_crl = (*source).clone();
    changed_crl.peer_trust.insert(
        profile_b.clone(),
        authoritative
            .clone()
            .with_crls(&source_b.crl_pem(&[]))
            .unwrap(),
    );
    assert_eq!(
        gens.activate(changed_crl),
        Err(TransportError::GenerationStale)
    );
    let mut changed_metadata = (*source).clone();
    changed_metadata
        .peer_trust
        .insert(profile_b.clone(), authoritative.clone().with_generation(99));
    assert_eq!(
        gens.activate(changed_metadata),
        Err(TransportError::GenerationStale)
    );
    assert_eq!(gens.current().number, generation);
    missing
}

#[test]
fn source_profiles_reject_mismatched_labels_and_removed_domains_cannot_return() {
    let server = DisposableCa::new("server");
    let ca_a = DisposableCa::new("domain-a");
    let stored_b = DisposableCa::new("stored-b");
    let source_b = DisposableCa::new("source-b");
    let unrelated = DisposableCa::new("unrelated");
    let gens = generations(server.issue_server("localhost").identity(), &ca_a);
    let owner = gens.source_owner();
    let reserved = gens.claim_source(&owner).unwrap();
    let first = gens
        .activate_from_source(&owner, reserved, candidate(&gens))
        .unwrap();
    let profile_b = profile_ref("federated.test");
    let mut with_stored = candidate(&gens);
    with_stored
        .peer_trust
        .insert(profile_b.clone(), private_root("federated.test", &stored_b));
    gens.activate(with_stored).unwrap();
    let mut source = candidate(&gens);
    let authoritative = spiffe_bundle("federated.test", &source_b);
    source
        .peer_trust
        .insert(profile_b.clone(), authoritative.clone());
    let active = gens
        .activate_from_source(&owner, first, source.clone())
        .unwrap();
    let missing =
        assert_source_trust_is_immutable(&gens, &owner, active, &source, &source_b, &stored_b);
    let mut unrelated_change = source.clone();
    unrelated_change.peer_trust.insert(
        profile_ref("unrelated"),
        private_root("unrelated", &unrelated),
    );
    gens.activate(unrelated_change).unwrap();
    let removed_epoch = gens
        .activate_from_source(&owner, active, missing.clone())
        .unwrap();
    assert_eq!(
        gens.activate(source.clone()),
        Err(TransportError::GenerationStale)
    );
    let restored = gens
        .activate_from_source(&owner, removed_epoch, source)
        .unwrap();
    assert!(gens.checked_current(Some(restored)).is_ok());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tls_only_keepalive_cannot_resume_after_source_handoff() {
    let tls_authority = DisposableCa::new("server");
    let ca = DisposableCa::new("clients");
    let gens = generations(tls_authority.issue_server("localhost").identity(), &ca);
    let initial = candidate(&gens);
    let first_owner = gens.source_owner();
    let reserved = gens.claim_source(&first_owner).unwrap();
    let first = gens
        .activate_from_source(&first_owner, reserved, initial.clone())
        .unwrap();
    let hits = Hits::default();
    let listener = serve(
        Arc::clone(&gens),
        profile_fn(TransportPolicy::ServerTls),
        router(Arc::clone(&gens), hits.clone()),
    )
    .await;
    let config = Arc::new(
        client_config(&ClientProfile {
            server_trust: private_root("servers", &tls_authority),
            server_name: ServerNamePolicy::Dns("localhost".into()),
            identity: None,
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
    gens.retire_source(&first_owner, first).unwrap();
    let next_owner = gens.source_owner();
    let reserved = gens.claim_source(&next_owner).unwrap();
    gens.activate_from_source(&next_owner, reserved, initial)
        .unwrap();
    assert_eq!(
        request_on(&mut existing, "/protected").await.unwrap().0,
        403
    );
    assert_eq!(
        raw_get(config, listener.addr, localhost(), "/protected")
            .await
            .unwrap()
            .0,
        200
    );
    assert_eq!(hits.protected(), 2);
    assert!(gens.checked_current_at(None, Utc::now()).is_ok());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn source_tls_only_listener_disables_ticket_resumption() {
    let server = DisposableCa::new("server");
    let ca = DisposableCa::new("clients");
    let gens = generations(server.issue_server("localhost").identity(), &ca);
    let initial = candidate(&gens);
    let owner = gens.source_owner();
    let reserved = gens.claim_source(&owner).unwrap();
    gens.activate_from_source(&owner, reserved, initial)
        .unwrap();
    let hits = Hits::default();
    let listener = serve(
        Arc::clone(&gens),
        profile_fn(TransportPolicy::ServerTls),
        router(Arc::clone(&gens), hits),
    )
    .await;
    let config = Arc::new(
        client_config(&ClientProfile {
            server_trust: private_root("servers", &server),
            server_name: ServerNamePolicy::Dns("localhost".into()),
            identity: None,
            min_version: TlsVersion::Tls13,
        })
        .unwrap(),
    );
    for _ in 0..3 {
        let mut stream = connect(Arc::clone(&config), listener.addr, localhost())
            .await
            .unwrap();
        assert_eq!(request_on(&mut stream, "/protected").await.unwrap().0, 200);
        assert_eq!(
            stream.get_ref().1.handshake_kind(),
            Some(rustls::HandshakeKind::Full)
        );
    }
    assert_eq!(listener.counters.resumed(), 0);
}

#[tokio::test]
async fn source_listener_refuses_a_profile_that_substitutes_its_identity() {
    let server = DisposableCa::new("server");
    let ca = DisposableCa::new("clients");
    let gens = generations(server.issue_server("localhost").identity(), &ca);
    let initial = candidate(&gens);
    let owner = gens.source_owner();
    let reserved = gens.claim_source(&owner).unwrap();
    gens.activate_from_source(&owner, reserved, initial)
        .unwrap();
    let other_identity = Arc::new(server.issue_server("localhost").identity());
    let result = SecureListener::bind("127.0.0.1:0".parse().unwrap(), gens, move |_| {
        Ok(ServerProfile::new(
            TransportPolicy::ServerTls,
            Arc::clone(&other_identity),
            "source-listener",
        ))
    })
    .await;
    assert_eq!(result.unwrap_err(), TransportError::GenerationStale);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ordinary_tls_resumes_but_a_prepared_connection_cannot_resume_after_source_claim() {
    let server = DisposableCa::new("server");
    let ca = DisposableCa::new("clients");
    let gens = generations(server.issue_server("localhost").identity(), &ca);
    let hits = Hits::default();
    let listener = serve(
        Arc::clone(&gens),
        profile_fn(TransportPolicy::ServerTls),
        router(Arc::clone(&gens), hits),
    )
    .await;
    let config = Arc::new(
        client_config(&ClientProfile {
            server_trust: private_root("servers", &server),
            server_name: ServerNamePolicy::Dns("localhost".into()),
            identity: None,
            min_version: TlsVersion::Tls13,
        })
        .unwrap(),
    );
    let mut first = connect(Arc::clone(&config), listener.addr, localhost())
        .await
        .unwrap();
    assert_eq!(request_on(&mut first, "/protected").await.unwrap().0, 200);
    let mut resumed = connect(Arc::clone(&config), listener.addr, localhost())
        .await
        .unwrap();
    assert_eq!(
        resumed.get_ref().1.handshake_kind(),
        Some(rustls::HandshakeKind::Resumed)
    );
    assert_eq!(request_on(&mut resumed, "/protected").await.unwrap().0, 200);

    // Capture the old acceptor before claiming the source, then offer the old
    // ticket only after the claim has quarantined that generation.
    let tcp = tokio::net::TcpStream::connect(listener.addr).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while listener.counters.handshakes_started() < 3 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the old acceptor was captured");
    let owner = gens.source_owner();
    gens.claim_source(&owner).unwrap();
    assert!(tokio_rustls::TlsConnector::from(config)
        .connect(localhost(), tcp)
        .await
        .is_err());
}

#[test]
fn ordinary_activation_cannot_relabel_a_source_owned_spiffe_domain() {
    let server = DisposableCa::new("server");
    let root = DisposableCa::new("domain-root");
    let gens = generations(server.issue_server("localhost").identity(), &root);
    let owner = gens.source_owner();
    let reserved = gens.claim_source(&owner).unwrap();
    let profile = profile_ref("federated.test");
    let authoritative = spiffe_bundle("federated.test", &root);
    let mut source = candidate(&gens);
    source
        .peer_trust
        .insert(profile.clone(), authoritative.clone());
    gens.activate_from_source(&owner, reserved, source.clone())
        .unwrap();
    let generation = gens.current().number;
    let relabeled = authoritative
        .clone()
        .with_spiffe_trust_domain("other.test")
        .unwrap();
    assert_eq!(relabeled.profile(), authoritative.profile());
    assert_eq!(relabeled.anchors(), authoritative.anchors());
    source.peer_trust.insert(profile.clone(), relabeled);
    assert_eq!(gens.activate(source), Err(TransportError::GenerationStale));
    let current = gens.current();
    assert_eq!(current.number, generation);
    assert_eq!(
        current.trust(&profile).unwrap().spiffe_trust_domain(),
        Some("federated.test")
    );
}
