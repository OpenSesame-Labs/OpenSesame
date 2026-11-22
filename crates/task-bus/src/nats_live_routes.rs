//! AT-NATS-TOPOLOGY: route TLS refuses a wrong CA; a correct two-node
//! cluster forwards messages. `INFO.connect_urls` never widens client egress.

use super::live_callout::core_client;
use super::live_harness::{free_port, route_node as node, Pki, Roles, Server};
use super::*;
use futures::StreamExt;
use std::time::Duration;

// The NATS fixture has no maximum-TLS-version setting. This proxy fixes the
// actual client handshake to TLS 1.2 or 1.3 and forwards NATS traffic to the
// real pinned server. It authenticates the client certificate itself.
use crate::nats::live_callout::{handshake_expectations, wait_for_reconnect_limit};
use crate::nats::live_delivery::material;
use crate::nats::live_mixed::spiffe_spec;
use crate::nats::live_tests::{config, direct_nats_reconnect};
use async_nats::rustls::{self, pki_types::pem::PemObject};
use opensesame_domain::transport::{TlsVersion, TrustProfileKind, TrustProfileRef};
use opensesame_transport_security::testkit::{IssuedLeaf, LeafSpec};
use opensesame_transport_security::{provider, TrustBundle};
use tokio::sync::mpsc;

type Handshake = Option<(rustls::ProtocolVersion, rustls::HandshakeKind)>;

struct Proxy {
    port: u16,
    events: mpsc::UnboundedReceiver<Handshake>,
    worker: tokio::task::JoinHandle<()>,
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.worker.abort();
    }
}

impl Proxy {
    async fn start(pki: &Pki, leaf: &IssuedLeaf, upstream: u16, tls12: bool) -> Self {
        let versions: &[&rustls::SupportedProtocolVersion] = if tls12 {
            &[&rustls::version::TLS12]
        } else {
            &[&rustls::version::TLS13]
        };
        let roots = TrustBundle::from_pem(
            TrustProfileRef::new("proxy-clients").unwrap(),
            TrustProfileKind::PrivateRoot,
            &pki.ca.ca_pem(),
        )
        .unwrap()
        .roots();
        let verifier =
            rustls::server::WebPkiClientVerifier::builder_with_provider(roots, provider())
                .build()
                .unwrap();
        let certs = rustls::pki_types::CertificateDer::pem_slice_iter(&leaf.cert_pem)
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let (_, key_path) = pki.write_leaf("reconnect-proxy", leaf);
        let key_bytes = std::fs::read(key_path).unwrap();
        let key = rustls::pki_types::PrivateKeyDer::from_pem_slice(&key_bytes).unwrap();
        let tls = rustls::ServerConfig::builder_with_provider(provider())
            .with_protocol_versions(versions)
            .unwrap()
            .with_client_cert_verifier(verifier)
            .with_single_cert(certs, key)
            .unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(tls));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, events) = mpsc::unbounded_channel();
        let worker = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            while let Ok((socket, _)) = listener.accept().await {
                connections.spawn(forward_socket(
                    socket,
                    acceptor.clone(),
                    tx.clone(),
                    upstream,
                ));
            }
        });
        Self {
            port,
            events,
            worker,
        }
    }

    fn url(&self) -> String {
        format!("tls://localhost:{}", self.port)
    }

    async fn next(&mut self) -> Handshake {
        tokio::time::timeout(Duration::from_secs(10), self.events.recv())
            .await
            .expect("TLS proxy observation timed out")
            .expect("TLS proxy stopped")
    }
}

async fn forward_socket(
    socket: tokio::net::TcpStream,
    acceptor: tokio_rustls::TlsAcceptor,
    tx: mpsc::UnboundedSender<Handshake>,
    upstream: u16,
) {
    let Ok(mut tls) = acceptor.accept(socket).await else {
        let _ = tx.send(None);
        return;
    };
    let connection = tls.get_ref().1;
    let event = Some((
        connection.protocol_version().unwrap(),
        connection.handshake_kind().unwrap(),
    ));
    let mut nats = tokio::net::TcpStream::connect(("127.0.0.1", upstream))
        .await
        .unwrap();
    let _ = tx.send(event);
    let _ = tokio::io::copy_bidirectional(&mut tls, &mut nats).await;
}

async fn exercise_guard(
    mut proxy: Proxy,
    mut spec: NatsTransportSpec,
    injected: InjectedMaterial,
    expected: [bool; 2],
    version: rustls::ProtocolVersion,
) {
    spec.max_reconnects = None;
    let opened = NatsJetStreamTaskBus::connect_with(
        config(&proxy.url(), spec.clone(), NatsRole::Publisher, false),
        injected.clone(),
    )
    .await;
    assert_eq!(opened.is_ok(), expected[0], "fresh handshake gate");
    let bus = opened.expect("initial NATS session");
    let old = bus.session.read().await.client.clone();
    old.flush().await.unwrap();
    assert_eq!(proxy.next().await.unwrap().0, version);
    old.force_reconnect().await.unwrap();
    assert_eq!(
        proxy.next().await.is_some(),
        expected[1],
        "spent handshake reconnected"
    );
    wait_for_reconnect_limit(&bus.health()).await;
    assert!(tokio::time::timeout(Duration::from_secs(5), old.flush())
        .await
        .expect("old reconnect worker did not stop")
        .is_err());
    tokio::time::timeout(
        Duration::from_secs(5),
        Box::pin(bus.rotate(spec, Some(injected))),
    )
    .await
    .expect("rotation did not return")
    .expect("explicit rotation");
    let fresh = bus.session.read().await.client.clone();
    fresh.flush().await.unwrap();
    assert_eq!(proxy.next().await.unwrap().0, version);
    fresh.force_reconnect().await.unwrap();
    assert_eq!(
        proxy.next().await.is_some(),
        expected[1],
        "rotated spent handshake reconnected"
    );
    wait_for_reconnect_limit(&bus.health()).await;
}

#[tokio::test]
#[ignore = "requires the pinned NATS fixture and Lean vectors"]
async fn injected_sessions_fence_reconnect_and_rotation() {
    assert!(
        super::live_harness::enabled(),
        "set OPENSESAME_MTLS_FIXTURES=1"
    );
    let expected = handshake_expectations();
    let pki = Pki::new();
    let port = free_port();
    let server = Server::start_with_args(
        "local-dev.conf",
        &[("OPENSESAME_NATS_LISTEN", format!("127.0.0.1:{port}"))],
        &[
            "-a".into(),
            "127.0.0.1".into(),
            "-p".into(),
            port.to_string(),
        ],
    );
    let client_leaf = pki.client("reconnect-client.test");
    let dns_leaf = pki.ca.issue_server("localhost");
    let spiffe_leaf = pki.ca.issue_with(&LeafSpec::spiffe("spiffe://a.test/nats"));
    let file = pki.client_spec(Some(&client_leaf), None, true);
    let mut source = spiffe_spec(None);
    source.transport.tls_first = true;
    let injected = material(&pki, &client_leaf, false);
    for tls12 in [true, false] {
        let version = if tls12 {
            rustls::ProtocolVersion::TLSv1_2
        } else {
            rustls::ProtocolVersion::TLSv1_3
        };
        let mut ordinary = Proxy::start(&pki, &dns_leaf, server.port, tls12).await;
        let mut ordinary_spec = file.clone();
        ordinary_spec.transport.min_version = if tls12 {
            TlsVersion::Tls12
        } else {
            TlsVersion::Tls13
        };
        let client = NatsJetStreamTaskBus::connect(config(
            &ordinary.url(),
            ordinary_spec,
            NatsRole::Publisher,
            false,
        ))
        .await
        .unwrap();
        let handle = client.session.read().await.client.clone();
        handle.flush().await.unwrap();
        assert_eq!(ordinary.next().await.unwrap().0, version);
        handle.force_reconnect().await.unwrap();
        let resumed = ordinary
            .next()
            .await
            .expect("ordinary session must reconnect");
        assert_eq!(resumed, (version, rustls::HandshakeKind::Resumed));
        let mut identity_only = file.clone();
        identity_only.transport.client_identity = source.transport.client_identity.clone();
        identity_only.locators.identity = source.locators.identity.clone();
        identity_only.transport.min_version = if tls12 {
            TlsVersion::Tls12
        } else {
            TlsVersion::Tls13
        };
        let proxy = Proxy::start(&pki, &dns_leaf, server.port, tls12).await;
        Box::pin(exercise_guard(
            proxy,
            identity_only,
            InjectedMaterial {
                identity: injected.identity.clone(),
                trust: None,
            },
            expected,
            version,
        ))
        .await;
        let mut trust_only = source.clone();
        trust_only.transport.client_identity = file.transport.client_identity.clone();
        trust_only.locators.identity = file.locators.identity.clone();
        trust_only.transport.min_version = if tls12 {
            TlsVersion::Tls12
        } else {
            TlsVersion::Tls13
        };
        let proxy = Proxy::start(&pki, &spiffe_leaf, server.port, tls12).await;
        Box::pin(exercise_guard(
            proxy,
            trust_only,
            InjectedMaterial {
                identity: None,
                trust: injected.trust.clone(),
            },
            expected,
            version,
        ))
        .await;
    }
    Box::pin(direct_nats_reconnect(&pki, injected)).await;
}

/// A route certificate from the wrong CA: the TLS route handshake fails and
/// no route is created. Route TLS is its own listener with its own trust —
/// client mTLS says nothing about it.
fn wrong_route_certificate_forms_no_cluster(
    pki: &Pki,
    roles: &Roles,
    good_a: &(std::path::PathBuf, std::path::PathBuf),
    bad_b: &(std::path::PathBuf, std::path::PathBuf),
    route_ca_pem: &std::path::Path,
) {
    let (ac, ar, bc, br) = (free_port(), free_port(), free_port(), free_port());
    let node_a = node(pki, roles, (ac, ar, br), good_a, route_ca_pem);
    let node_b = node(pki, roles, (bc, br, ar), bad_b, route_ca_pem);
    let refused = node_a.wait_log("TLS route handshake error", Duration::from_secs(6))
        || node_b.wait_log("TLS route handshake error", Duration::from_secs(1));
    assert!(
        refused,
        "a route with a wrong certificate must be refused:\nA: {}\nB: {}",
        node_a.log_text(),
        node_b.log_text()
    );
    assert!(
        !node_a.log_text().contains("Route connection created"),
        "no route may form: {}",
        node_a.log_text()
    );
}

/// With route certificates from the route CA the cluster forms and a message
/// published on B reaches a subscriber on A.
async fn message_crosses_the_tls_route(pki: &Pki, roles: &Roles, a: &Server, b: &Server) {
    let client_a = core_client(pki, roles, &a.url()).await;
    let client_b = core_client(pki, roles, &b.url()).await;
    let mut sub = client_a
        .subscribe("opensesame.events.route.test")
        .await
        .expect("subscribe on A");
    client_a.flush().await.expect("flush");
    // Interest propagates over the route; retry the publish briefly.
    let mut got = None;
    for _ in 0..20 {
        client_b
            .publish("opensesame.events.route.test", "via-b".into())
            .await
            .expect("publish on B");
        client_b.flush().await.expect("flush");
        if let Ok(Some(msg)) = tokio::time::timeout(Duration::from_millis(300), sub.next()).await {
            got = Some(msg);
            break;
        }
    }
    let msg = got.expect("a message published on B is consumed on A over the TLS route");
    assert_eq!(msg.payload.as_ref(), b"via-b");
}

/// AT-NATS-DOWNGRADE (discovery half): A advertises B in `connect_urls`, but
/// the secure profile sets `ignore_discovered_servers`. Kill A and the client
/// must not reappear on B — discovery never widens egress.
async fn discovery_does_not_widen_egress(pki: &Pki, roles: &Roles, node_a: &mut Server) {
    let health = std::sync::Arc::new(BusHealth::default());
    let leaf = pki.client("pinned.nats.opensesame.test");
    let spec = pki
        .client_spec(Some(&leaf), Some(&roles.host.0), false)
        .normalized(&node_a.url())
        .expect("spec");
    let options = crate::nats_connect::connect_options(
        &spec,
        NatsRole::Host,
        &InjectedMaterial::default(),
        std::sync::Arc::clone(&health),
    )
    .await
    .expect("options");
    let pinned = options.connect(node_a.url()).await.expect("pinned client");
    assert!(
        !pinned.server_info().connect_urls.is_empty(),
        "A must advertise B for this test to mean anything: {:?}",
        pinned.server_info()
    );
    node_a.kill();
    tokio::time::sleep(Duration::from_secs(4)).await;
    assert_ne!(
        pinned.connection_state(),
        async_nats::connection::State::Connected,
        "client must not reconnect through a discovered server"
    );
    assert!(health.disconnects() >= 1);
}

/// AT-NATS-TOPOLOGY (routes): wrong route certificate → no cluster; right
/// ones → a message crosses; and discovery still does not widen egress.
#[tokio::test]
#[ignore = "requires OPENSESAME_MTLS_FIXTURES=1"]
async fn route_tls_refuses_wrong_certificates_and_forwards_with_right_ones() {
    if !super::live_harness::enabled() {
        return;
    }
    let pki = Pki::new();
    let roles = Roles::new();
    let route_ca = opensesame_transport_security::testkit::DisposableCa::new("route-ca");
    let route_ca_pem =
        super::live_harness::write(pki.dir.path(), "route-ca.pem", &route_ca.ca_pem());
    let good_a = pki.write_leaf("route-a", &Pki::route_leaf(&route_ca));
    let good_b = pki.write_leaf("route-b", &Pki::route_leaf(&route_ca));
    let bad_b = pki.write_leaf("route-b-bad", &Pki::route_leaf(&pki.other_ca));

    wrong_route_certificate_forms_no_cluster(&pki, &roles, &good_a, &bad_b, &route_ca_pem);

    let (ac, ar, bc, br) = (free_port(), free_port(), free_port(), free_port());
    let mut node_a = node(&pki, &roles, (ac, ar, br), &good_a, &route_ca_pem);
    let node_b = node(&pki, &roles, (bc, br, ar), &good_b, &route_ca_pem);
    assert!(
        node_a.wait_log("Route connection created", Duration::from_secs(8))
            || node_b.wait_log("Route connection created", Duration::from_secs(2)),
        "route did not form:\nA: {}\nB: {}",
        node_a.log_text(),
        node_b.log_text()
    );

    Box::pin(message_crosses_the_tls_route(
        &pki, &roles, &node_a, &node_b,
    ))
    .await;
    Box::pin(discovery_does_not_widen_egress(&pki, &roles, &mut node_a)).await;
    drop(node_b);
}
