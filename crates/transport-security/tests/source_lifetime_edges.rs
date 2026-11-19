//! Runtime tests for source-owned trust and TLS-only connection epochs.
mod common;
use opensesame_time::Utc;
use common::*;
use opensesame_domain::transport::{TlsVersion, TransportError, TransportPolicy};
use opensesame_transport_security::testkit::DisposableCa;
use opensesame_transport_security::{
    client_config, ClientProfile, GenerationCandidate, ServerNamePolicy, SourceOwner,
    TransportGenerations, TrustBundle,
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
