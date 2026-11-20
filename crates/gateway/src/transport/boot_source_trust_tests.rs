//! A configured SPIFFE trust domain must come from the current source view.
use std::sync::Arc;
use std::time::Duration;

use axum::{routing::get, Router};
use chrono::Utc;
use opensesame_domain::transport::{
    ServiceBindingSet, TlsVersion, TrustProfileKind, TrustProfileRef,
};
use opensesame_transport_security::testkit::DisposableCa;
use opensesame_transport_security::{
    client_config, ClientProfile, GenerationCandidate, NativeIdentitySpec, NativeTrustSpec,
    ServerNamePolicy, SourceOwner, TransportGenerations, TrustBundle,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::bind_secure_listener;
use crate::app_state::AppState;
use crate::transport::test_support;
use crate::transport_lifecycle::{trust, LifecycleState};

const OWN: &str = "own.test";
const FOREIGN: &str = "foreign.test";

fn profile(name: &str) -> TrustProfileRef {
    TrustProfileRef::new(name).unwrap()
}

fn bundle(name: &str, ca: &DisposableCa) -> TrustBundle {
    TrustBundle::from_pem(
        profile(name),
        TrustProfileKind::SpiffeTrustDomain,
        &ca.root_pem(),
    )
    .unwrap()
}

fn source_manager(candidate: GenerationCandidate) -> (Arc<TransportGenerations>, SourceOwner, u64) {
    let initial = GenerationCandidate::default()
        .into_generation(1, Utc::now())
        .unwrap();
    let generations = TransportGenerations::new(initial);
    let owner = generations.source_owner();
    let reserved = generations.claim_source(&owner).unwrap();
    let epoch = generations
        .activate_from_source(&owner, reserved, candidate)
        .unwrap();
    (generations, owner, epoch)
}

fn attach(state: &mut AppState, generations: &Arc<TransportGenerations>) {
    let mut config = test_support::mtls_config();
    let listener = config.listener.as_mut().unwrap();
    listener.identity = NativeIdentitySpec::Spiffe {
        spiffe_id: "spiffe://own.test/host".into(),
        endpoint_socket: "/tmp/unused.sock".into(),
    };
    listener.client_trust = Some(NativeTrustSpec::SpiffeTrustDomain {
        trust_domain: FOREIGN.into(),
        endpoint_socket: "/tmp/unused.sock".into(),
    });
    listener.client_trust_profile = profile(FOREIGN);
    let mut runtime =
        test_support::runtime_serving(Arc::clone(generations), ServiceBindingSet::empty(), config);
    Arc::get_mut(&mut runtime).unwrap().client_trust_profile = profile(FOREIGN);
    state.transport_lifecycle.attach_generations(
        Arc::clone(generations),
        generations.current().peer_trust.clone(),
    );
    state.transport = Some(runtime);
}

fn stored(name: &str, ca: &DisposableCa) -> trust::StoredTrustProfile {
    trust::StoredTrustProfile {
        profile: profile(name),
        kind: TrustProfileKind::SpiffeTrustDomain,
        anchors_pem: String::from_utf8(ca.root_pem()).unwrap(),
        retiring_anchors_pem: None,
        overlap_until: None,
        enabled: true,
        trust_domain: Some(name.into()),
    }
}

type ClientStream = tokio_rustls::client::TlsStream<tokio::net::TcpStream>;

async fn connect(
    address: std::net::SocketAddr,
    server_ca: &DisposableCa,
    client_ca: &DisposableCa,
) -> Option<ClientStream> {
    let leaf = client_ca.issue_spiffe(&format!("spiffe://{FOREIGN}/client"));
    let root = TrustBundle::from_pem(
        profile("servers"),
        TrustProfileKind::PrivateRoot,
        &server_ca.root_pem(),
    )
    .unwrap();
    let config = client_config(&ClientProfile {
        server_trust: root,
        server_name: ServerNamePolicy::Dns("localhost".into()),
        identity: Some(Arc::new(leaf.identity())),
        min_version: TlsVersion::Tls13,
    })
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        let tcp = tokio::net::TcpStream::connect(address).await.ok()?;
        let name = rustls::pki_types::ServerName::try_from("localhost").ok()?;
        tokio_rustls::TlsConnector::from(Arc::new(config))
            .connect(name, tcp)
            .await
            .ok()
    })
    .await
    .ok()
    .flatten()
}

async fn status(stream: &mut ClientStream) -> Option<u16> {
    tokio::time::timeout(Duration::from_secs(5), async {
        stream
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n")
            .await
            .ok()?;
        let mut response = Vec::new();
        loop {
            let mut chunk = [0u8; 1024];
            let count = stream.read(&mut chunk).await.ok()?;
            if count == 0 {
                return None;
            }
            response.extend_from_slice(&chunk[..count]);
            if response
                .windows(4)
                .position(|w| w == b"\r\n\r\n")
                .is_some_and(|header| response.len() >= header + 6)
            {
                return std::str::from_utf8(response.get(9..12)?).ok()?.parse().ok();
            }
            if response.len() > 64 * 1024 {
                return None;
            }
        }
    })
    .await
    .ok()
    .flatten()
}

struct Restarted {
    state: AppState,
    manager: Arc<TransportGenerations>,
    owner: SourceOwner,
    epoch: u64,
    source: GenerationCandidate,
}

async fn restart_with_stored_domain(
    server_ca: &DisposableCa,
    own_ca: &DisposableCa,
    source_ca: &DisposableCa,
    stored_ca: &DisposableCa,
    unrelated_ca: &DisposableCa,
) -> Restarted {
    let mut first_state = crate::transport_lifecycle::test_support::state().await;
    let mut source = GenerationCandidate {
        identity: Some(Arc::new(server_ca.issue_server("localhost").identity())),
        peer_trust: [(profile(OWN), bundle(OWN, own_ca))].into(),
        own_trust: None,
        identity_required: true,
    };
    let (first_manager, first_owner, first_epoch) = source_manager(source.clone());
    attach(&mut first_state, &first_manager);
    trust::put_cas(
        &first_state,
        trust::TrustProfileSet {
            revision: 0,
            profiles: vec![
                stored(FOREIGN, stored_ca),
                stored("unrelated", unrelated_ca),
            ],
        },
        "operator",
        false,
    )
    .await
    .unwrap();
    source
        .peer_trust
        .insert(profile(FOREIGN), bundle(FOREIGN, source_ca));
    let epoch = first_manager
        .activate_from_source(&first_owner, first_epoch, source.clone())
        .unwrap();
    source.peer_trust.remove(&profile(FOREIGN));
    first_manager
        .activate_from_source(&first_owner, epoch, source.clone())
        .unwrap();
    drop(first_manager);
    // A fresh manager lacks B's historical tombstone; the same stored B and C
    // are really loaded, reproducing the cross-restart ambiguity.
    let mut state = AppState {
        transport_lifecycle: LifecycleState::new(),
        transport: None,
        ..first_state.clone()
    };
    let (manager, owner, epoch) = source_manager(source.clone());
    attach(&mut state, &manager);
    trust::refresh(&state, Utc::now()).await.unwrap();
    Restarted {
        state,
        manager,
        owner,
        epoch,
        source,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restart_cannot_use_a_stored_bundle_for_a_source_selected_domain() {
    let server_ca = DisposableCa::new("server");
    let own_ca = DisposableCa::new("own");
    let source_ca = DisposableCa::new("source-foreign");
    let stored_ca = DisposableCa::new("stored-foreign");
    let unrelated_ca = DisposableCa::new("unrelated");
    let Restarted {
        state,
        manager,
        owner,
        mut epoch,
        mut source,
    } = restart_with_stored_domain(&server_ca, &own_ca, &source_ca, &stored_ca, &unrelated_ca)
        .await;
    assert!(manager.current().trust(&profile(FOREIGN)).is_ok());
    assert!(manager.current().trust(&profile("unrelated")).is_ok());
    assert!(!manager
        .source_trust(manager.current().number)
        .unwrap()
        .unwrap()
        .bundles
        .contains_key(&profile(FOREIGN)));
    let address = "127.0.0.1:0".parse().unwrap();
    let runtime = state.transport.as_ref().unwrap();
    assert!(bind_secure_listener(&state, runtime, address)
        .await
        .unwrap_err()
        .to_string()
        .contains("trust_unknown"));
    // Even an owned generic source bundle is refused if its kind is wrong.
    let wrong_kind = TrustBundle::from_pem(
        profile(FOREIGN),
        TrustProfileKind::PrivateRoot,
        &source_ca.root_pem(),
    )
    .unwrap();
    source.peer_trust.insert(profile(FOREIGN), wrong_kind);
    epoch = manager
        .activate_from_source(&owner, epoch, source.clone())
        .unwrap();
    assert!(bind_secure_listener(&state, runtime, address)
        .await
        .unwrap_err()
        .to_string()
        .contains("trust_unknown"));
    let prior_generation = manager.current().number;
    source
        .peer_trust
        .insert(profile(FOREIGN), bundle(FOREIGN, &source_ca));
    epoch = manager
        .activate_from_source(&owner, epoch, source.clone())
        .unwrap();
    assert!(matches!(
        manager.source_trust(prior_generation),
        Err(opensesame_domain::TransportError::GenerationStale)
    ));
    let listener = bind_secure_listener(&state, runtime, address)
        .await
        .unwrap();
    let listen = listener.local_addr();
    let app = Router::new().route("/", get(|| async { "ok" })).layer(
        axum::middleware::from_fn_with_state(
            manager.clone(),
            opensesame_transport_security::enforce_current_generation,
        ),
    );
    let task = tokio::spawn(listener.serve(app));
    let mut live = connect(listen, &server_ca, &source_ca)
        .await
        .expect("source CA handshake");
    assert_eq!(status(&mut live).await, Some(200));
    if let Some(mut wrong) = connect(listen, &server_ca, &stored_ca).await {
        assert_ne!(status(&mut wrong).await, Some(200));
    }
    // A live connection and a new handshake both fail once B is removed.
    source.peer_trust.remove(&profile(FOREIGN));
    manager.activate_from_source(&owner, epoch, source).unwrap();
    assert_eq!(status(&mut live).await, Some(403));
    if let Some(mut attempted) = connect(listen, &server_ca, &source_ca).await {
        assert_ne!(status(&mut attempted).await, Some(200));
    }
    task.abort();
}
