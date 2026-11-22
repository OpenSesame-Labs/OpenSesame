//! Source ownership wins over stored names, including later federation.
use super::*;
use opensesame_transport_security::{env::NativeIdentitySpec, TrustBundle};

async fn assert_collision_cleanup(
    state: &AppState,
    gens: &TransportGenerations,
    source_b: &TrustBundle,
    stored_b: &StoredTrustProfile,
    unrelated_ca: &DisposableCa,
) -> StoredTrustProfile {
    let fed = support::profile_ref("federated.test");
    let live_before = gens.current().number;
    assert!(trust::put_cas(
        state,
        TrustProfileSet {
            revision: 1,
            profiles: vec![stored_b.clone()]
        },
        "operator",
        false
    )
    .await
    .is_err());
    assert_eq!(trust::load(state).await.unwrap().revision, 1);
    assert_eq!(gens.current().number, live_before);
    let cleaned = trust::put_cas(
        state,
        TrustProfileSet {
            revision: 1,
            profiles: vec![],
        },
        "operator",
        false,
    )
    .await
    .unwrap();
    assert_eq!(cleaned.revision, 2);
    assert_eq!(
        gens.current().trust(&fed).unwrap().anchors(),
        source_b.anchors()
    );
    let c = profile("unrelated", unrelated_ca);
    let updated = trust::put_cas(
        state,
        TrustProfileSet {
            revision: 2,
            profiles: vec![c.clone()],
        },
        "operator",
        false,
    )
    .await
    .unwrap();
    assert_eq!(updated.revision, 3);
    assert_eq!(
        gens.current().trust(&fed).unwrap().anchors(),
        source_b.anchors()
    );
    c
}

#[tokio::test]
async fn source_collision_can_be_removed_without_shadowing_federated_trust() {
    let mut state = support::state().await;
    let server_ca = DisposableCa::new("own-source");
    let client_ca = DisposableCa::new("boot-clients");
    let stored_ca = DisposableCa::new("stored-federation");
    let source_ca = DisposableCa::new("source-federation");
    let unrelated_ca = DisposableCa::new("unrelated");
    let server = server_ca.issue_server("localhost").identity();
    let gens = support::generations(server, &client_ca);
    state
        .transport_lifecycle
        .attach_generations(gens.clone(), gens.current().peer_trust.clone());
    let mut config = crate::transport::test_support::mtls_config();
    config.listener.as_mut().unwrap().identity = NativeIdentitySpec::Spiffe {
        spiffe_id: "spiffe://source.test/gateway".into(),
        endpoint_socket: "/tmp/source-test.sock".into(),
    };
    state.transport = Some(crate::transport::test_support::runtime_serving(
        gens.clone(),
        crate::transport::test_support::set(vec![]),
        config,
    ));
    let own = support::profile_ref("source.test");
    let fed = support::profile_ref("federated.test");
    let make_bundle = |name: &str, ca: &DisposableCa| {
        TrustBundle::from_pem(
            support::profile_ref(name),
            TrustProfileKind::SpiffeTrustDomain,
            &ca.root_pem(),
        )
        .unwrap()
    };
    let mut source = GenerationCandidate {
        identity: gens.current().identity.clone(),
        peer_trust: gens.current().peer_trust.clone(),
        own_trust: Some(own.clone()),
        identity_required: true,
    };
    source
        .peer_trust
        .insert(own, make_bundle("source.test", &server_ca));
    let owner = gens.source_owner();
    let reserved = gens.claim_source(&owner).unwrap();
    let epoch = gens
        .activate_from_source(&owner, reserved, source.clone())
        .unwrap();
    let stored_b = profile("federated.test", &stored_ca);
    let stored = trust::put_cas(
        &state,
        TrustProfileSet {
            revision: 0,
            profiles: vec![stored_b.clone()],
        },
        "operator",
        false,
    )
    .await
    .unwrap();
    assert_eq!(
        stored.revision, 1,
        "an unrelated stored profile is allowed before federation"
    );
    let source_b = make_bundle("federated.test", &source_ca);
    source.peer_trust.insert(fed.clone(), source_b.clone());
    let epoch = gens
        .activate_from_source(&owner, epoch, source.clone())
        .unwrap();
    let c = assert_collision_cleanup(&state, &gens, &source_b, &stored_b, &unrelated_ca).await;
    source.peer_trust.remove(&fed);
    gens.activate_from_source(&owner, epoch, source).unwrap();
    assert!(trust::put_cas(
        &state,
        TrustProfileSet {
            revision: 3,
            profiles: vec![stored_b, c]
        },
        "operator",
        false
    )
    .await
    .is_err());
    assert!(
        gens.current().trust(&fed).is_err(),
        "a removed source domain cannot be resurrected in this manager"
    );
    assert_eq!(trust::load(&state).await.unwrap().revision, 3);
}
