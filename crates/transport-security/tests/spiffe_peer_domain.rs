//! SPIFFE trust domains constrain the peer ID and its authorizing selectors.
mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::Router;
use common::*;
use opensesame_domain::transport::{
    operations, BindingPurpose, BindingScope, PeerIdentitySelector, ServiceBinding,
    ServiceBindingSet, ServiceCaller, TlsVersion, TransportPolicy, TrustProfileKind,
};
use opensesame_transport_security::testkit::{DisposableCa, IssuedLeaf, LeafSpec, SanEntry};
use opensesame_transport_security::{
    client_config, enforce_current_generation, ClientProfile, GenerationCandidate, PeerExtension,
    ServerNamePolicy, TransportGenerations, TrustBundle,
};
use serde_json::{json, Value};

const DOMAIN: &str = "example.test";
const ID: &str = "spiffe://example.test/workload";

async fn listener(server: &DisposableCa, clients: TrustBundle) -> Served {
    let identity = server.issue_server("localhost").identity();
    let manager = generations(identity, &DisposableCa::new("unused"));
    let app = router(manager.clone(), Hits::default());
    serve(
        manager,
        move |generation| {
            let identity = generation
                .identity
                .clone()
                .ok_or(opensesame_domain::transport::TransportError::IdentityMissing)?;
            let mut profile = opensesame_transport_security::ServerProfile::new(
                TransportPolicy::MtlsRequired,
                identity,
                LISTENER,
            );
            profile.client_trust = Some(clients.clone());
            Ok(profile)
        },
        app,
    )
    .await
}

fn client(server: &DisposableCa, leaf: &IssuedLeaf) -> Arc<rustls::ClientConfig> {
    Arc::new(
        client_config(&ClientProfile {
            server_trust: private_root("servers", server),
            server_name: ServerNamePolicy::Dns("localhost".into()),
            identity: Some(Arc::new(leaf.identity())),
            min_version: TlsVersion::Tls13,
        })
        .unwrap(),
    )
}

async fn who(server: &DisposableCa, leaf: &IssuedLeaf, listener: &Served) -> Result<Value, String> {
    let (status, body) =
        raw_get(client(server, leaf), listener.addr, localhost(), "/whoami").await?;
    if status != 200 {
        return Err(format!("status {status}"));
    }
    serde_json::from_str(&body).map_err(|error| error.to_string())
}

#[derive(Clone)]
struct LiveAdmission {
    generations: Arc<TransportGenerations>,
    bindings: Arc<RwLock<ServiceBindingSet>>,
    admitted: Arc<AtomicUsize>,
}

fn binding(selector: PeerIdentitySelector, denied: Vec<String>) -> ServiceBindingSet {
    let set = ServiceBindingSet {
        revision: 1,
        bindings: vec![ServiceBinding {
            id: "bridge".into(),
            revision: 1,
            enabled: true,
            revoked: false,
            scope: BindingScope::Deployment,
            trust_profile: profile_ref("peers"),
            peer: selector,
            service_principal: "svc:bridge".into(),
            purpose: BindingPurpose::NatsAuthBridge,
            allowed_operations: vec![operations::NATS_CALLOUT_DECIDE.into()],
            allowed_audiences: vec!["host".into()],
            not_after: None,
            denied_thumbprints: denied,
        }],
    };
    set.validate().unwrap();
    set
}

async fn admit_service(
    State(state): State<LiveAdmission>,
    request: Request,
) -> (StatusCode, &'static str) {
    let Some(peer) = request.extensions().get::<PeerExtension>() else {
        return (StatusCode::FORBIDDEN, "peer_missing");
    };
    let current = match state
        .generations
        .checked_current(Some(peer.0.credential_generation()))
    {
        Ok(current) => current,
        Err(error) => return (StatusCode::FORBIDDEN, error.code()),
    };
    if let Err(error) = current.trust(peer.0.trust_profile()) {
        return (StatusCode::FORBIDDEN, error.code());
    }
    let bindings = state.bindings.read().unwrap();
    let admitted = ServiceCaller::admit(
        peer.0.as_ref().clone(),
        &BindingScope::Deployment,
        &bindings,
        BindingPurpose::NatsAuthBridge,
        current.number,
        current.number,
        chrono::Utc::now(),
    )
    .and_then(|caller| caller.require_operation(operations::NATS_CALLOUT_DECIDE));
    match admitted {
        Ok(()) => {
            state.admitted.fetch_add(1, Ordering::SeqCst);
            (StatusCode::OK, "authorized")
        }
        Err(error) => (StatusCode::FORBIDDEN, error.code()),
    }
}

async fn service_listener(
    server: &DisposableCa,
    authority: &DisposableCa,
) -> (Served, LiveAdmission) {
    let trust = spiffe_bundle("peers", authority)
        .with_spiffe_trust_domain(DOMAIN)
        .unwrap();
    let candidate = GenerationCandidate {
        identity: Some(Arc::new(server.issue_server("localhost").identity())),
        peer_trust: [(profile_ref("peers"), trust)].into(),
        own_trust: None,
        identity_required: true,
    };
    let generations =
        TransportGenerations::new(candidate.into_generation(1, chrono::Utc::now()).unwrap());
    let state = LiveAdmission {
        generations: Arc::clone(&generations),
        bindings: Arc::new(RwLock::new(binding(
            PeerIdentitySelector::SpiffeId(ID.into()),
            vec![],
        ))),
        admitted: Arc::new(AtomicUsize::new(0)),
    };
    let app = Router::new()
        .route("/service", get(admit_service))
        .with_state(state.clone())
        .layer(axum::middleware::from_fn_with_state(
            Arc::clone(&generations),
            enforce_current_generation,
        ));
    let running = serve(
        generations,
        |generation| {
            let identity = generation
                .identity
                .clone()
                .ok_or(opensesame_domain::transport::TransportError::IdentityMissing)?;
            let mut profile = opensesame_transport_security::ServerProfile::new(
                TransportPolicy::MtlsRequired,
                identity,
                LISTENER,
            );
            profile.client_trust = Some(generation.trust(&profile_ref("peers"))?.clone());
            Ok(profile)
        },
        app,
    )
    .await;
    (running, state)
}

async fn service_call(
    server: &DisposableCa,
    leaf: &IssuedLeaf,
    listener: &Served,
) -> Result<(u16, String), String> {
    tokio::time::timeout(
        Duration::from_secs(5),
        raw_get(client(server, leaf), listener.addr, localhost(), "/service"),
    )
    .await
    .expect("service request timed out")
}

#[tokio::test]
async fn live_tls_spiffe_identity_is_required_for_service_admission() {
    let server = DisposableCa::new("server");
    let authority = DisposableCa::new("domain-ca");
    let foreign_ca = DisposableCa::new("foreign-ca");
    let mut good_spec = LeafSpec::spiffe(ID);
    good_spec
        .sans
        .push(SanEntry::Dns("peer.example.test".into()));
    let good = authority.issue_with(&good_spec);
    let (listener, state) = service_listener(&server, &authority).await;
    assert_eq!(
        service_call(&server, &good, &listener).await.unwrap(),
        (200, "authorized".into())
    );

    *state.bindings.write().unwrap() = binding(
        PeerIdentitySelector::SpiffeId("spiffe://example.test/other".into()),
        vec![],
    );
    assert_eq!(
        service_call(&server, &good, &listener).await.unwrap(),
        (403, "peer_not_bound".into())
    );
    *state.bindings.write().unwrap() = binding(
        PeerIdentitySelector::DnsName("peer.example.test".into()),
        vec![],
    );
    assert_eq!(
        service_call(&server, &good, &listener).await.unwrap(),
        (403, "peer_not_bound".into())
    );
    *state.bindings.write().unwrap() = binding(
        PeerIdentitySelector::LeafThumbprintSha256(good.thumbprint.clone()),
        vec![],
    );
    assert_eq!(
        service_call(&server, &good, &listener).await.unwrap(),
        (403, "peer_not_bound".into())
    );
    *state.bindings.write().unwrap() = binding(
        PeerIdentitySelector::SpiffeId(ID.into()),
        vec![good.thumbprint.clone()],
    );
    assert_eq!(
        service_call(&server, &good, &listener).await.unwrap(),
        (403, "evidence_revoked".into())
    );

    let wrong_id = "spiffe://other.test/workload";
    *state.bindings.write().unwrap() =
        binding(PeerIdentitySelector::SpiffeId(wrong_id.into()), vec![]);
    assert!(
        service_call(&server, &authority.issue_spiffe(wrong_id), &listener)
            .await
            .is_err()
    );
    *state.bindings.write().unwrap() = binding(PeerIdentitySelector::SpiffeId(ID.into()), vec![]);
    assert!(
        service_call(&server, &foreign_ca.issue_spiffe(ID), &listener)
            .await
            .is_err()
    );
    assert_eq!(state.admitted.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn source_domain_is_checked_before_exact_spiffe_peer_evidence() {
    let server = DisposableCa::new("server");
    let authority = DisposableCa::new("domain-ca");
    let foreign = DisposableCa::new("foreign-ca");
    // The profile label is deliberately different from the trust domain.
    let trust = spiffe_bundle("peers", &authority)
        .with_spiffe_trust_domain(DOMAIN)
        .unwrap();
    let running = listener(&server, trust).await;
    let mut spec = LeafSpec::spiffe(ID);
    spec.sans.push(SanEntry::Dns("peer.example.test".into()));
    let good = authority.issue_with(&spec);
    let response = who(&server, &good, &running).await.unwrap();
    assert_eq!(response["peer"]["identities"], json!([{ "spiffe_id": ID }]));
    assert_eq!(response["peer"]["trust_profile"]["name"], "peers");
    assert_eq!(response["peer"]["leaf_thumbprint_sha256"], good.thumbprint);
    let wrong_domain = authority.issue_spiffe("spiffe://other.test/workload");
    assert!(who(&server, &wrong_domain, &running).await.is_err());
    let wrong_ca = foreign.issue_spiffe(ID);
    assert!(who(&server, &wrong_ca, &running).await.is_err());
    let mut multiple = LeafSpec::spiffe(ID);
    multiple
        .sans
        .push(SanEntry::Uri("spiffe://example.test/other".into()));
    assert!(who(&server, &authority.issue_with(&multiple), &running)
        .await
        .is_err());
    let mut missing = LeafSpec::spiffe(ID);
    missing.sans.clear();
    assert!(who(&server, &authority.issue_with(&missing), &running)
        .await
        .is_err());
    let mut client_only = LeafSpec::spiffe(ID);
    client_only.server_auth = false;
    assert!(who(&server, &authority.issue_with(&client_only), &running)
        .await
        .is_err());
    let mut no_key_usage = LeafSpec::spiffe(ID);
    no_key_usage.key_usages.clear();
    assert!(who(&server, &authority.issue_with(&no_key_usage), &running)
        .await
        .is_err());
}

#[tokio::test]
async fn private_root_evidence_retains_dns_and_thumbprint_selectors() {
    let server = DisposableCa::new("server");
    let authority = DisposableCa::new("private-ca");
    let running = listener(&server, private_root("peers", &authority)).await;
    let peer = authority.issue_with(&LeafSpec::client(vec![SanEntry::Dns(
        "peer.example.test".into(),
    )]));
    let response = who(&server, &peer, &running).await.unwrap();
    let selectors = response["peer"]["identities"].as_array().unwrap();
    assert!(selectors.contains(&json!({ "dns_name": "peer.example.test" })));
    assert!(selectors.contains(&json!({ "leaf_thumbprint_sha256": peer.thumbprint })));
}

#[test]
fn spiffe_domain_metadata_is_explicit_and_canonical() {
    let ca = DisposableCa::new("root");
    let spiffe = TrustBundle::from_pem(
        profile_ref("peers"),
        TrustProfileKind::SpiffeTrustDomain,
        &ca.root_pem(),
    )
    .unwrap();
    assert!(spiffe
        .clone()
        .with_spiffe_trust_domain("EXAMPLE.test")
        .is_err());
    assert!(spiffe
        .clone()
        .with_spiffe_trust_domain("spiffe://example.test/path")
        .is_err());
    assert_eq!(
        spiffe
            .with_spiffe_trust_domain(DOMAIN)
            .unwrap()
            .spiffe_trust_domain(),
        Some(DOMAIN)
    );
    assert!(private_root("private", &ca)
        .with_spiffe_trust_domain(DOMAIN)
        .is_err());
}
