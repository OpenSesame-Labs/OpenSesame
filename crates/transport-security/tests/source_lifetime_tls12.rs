//! TLS 1.2 controls for generation-bound resumption and source claims.
mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{
    connect, generations, localhost, private_root, profile_fn, request_on, router, serve, Hits,
};
use opensesame_domain::transport::{TlsVersion, TransportError, TransportPolicy};
use opensesame_transport_security::testkit::DisposableCa;
use opensesame_transport_security::{Generation, GenerationCandidate, ServerProfile};

fn tls12_profile(generation: &Generation) -> Result<ServerProfile, TransportError> {
    let mut profile = profile_fn(TransportPolicy::ServerTls)(generation)?;
    profile.min_version = TlsVersion::Tls12;
    Ok(profile)
}

fn tls12_client(server: &DisposableCa) -> Arc<rustls::ClientConfig> {
    let roots = private_root("servers", server).roots();
    Arc::new(
        rustls::ClientConfig::builder_with_provider(opensesame_transport_security::provider())
            .with_protocol_versions(&[&rustls::version::TLS12])
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth(),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn source_tls12_listener_never_resumes() {
    let server = DisposableCa::new("server");
    let ca = DisposableCa::new("clients");
    let gens = generations(server.issue_server("localhost").identity(), &ca);
    let current = gens.current();
    let candidate = GenerationCandidate {
        identity: current.identity.clone(),
        peer_trust: current.peer_trust.clone(),
        own_trust: None,
        identity_required: true,
    };
    let owner = gens.source_owner();
    let reserved = gens.claim_source(&owner).unwrap();
    gens.activate_from_source(&owner, reserved, candidate)
        .unwrap();
    let listener = serve(
        Arc::clone(&gens),
        tls12_profile,
        router(Arc::clone(&gens), Hits::default()),
    )
    .await;
    let config = tls12_client(&server);
    for _ in 0..3 {
        let mut stream = connect(Arc::clone(&config), listener.addr, localhost())
            .await
            .unwrap();
        assert_eq!(request_on(&mut stream, "/protected").await.unwrap().0, 200);
        let connection = stream.get_ref().1;
        assert_eq!(
            connection.protocol_version(),
            Some(rustls::ProtocolVersion::TLSv1_2)
        );
        assert_eq!(
            connection.handshake_kind(),
            Some(rustls::HandshakeKind::Full)
        );
    }
    assert_eq!(listener.counters.resumed(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tls12_session_prepared_before_claim_cannot_resume_after_claim() {
    let server = DisposableCa::new("server");
    let ca = DisposableCa::new("clients");
    let gens = generations(server.issue_server("localhost").identity(), &ca);
    let listener = serve(
        Arc::clone(&gens),
        tls12_profile,
        router(Arc::clone(&gens), Hits::default()),
    )
    .await;
    let config = tls12_client(&server);
    let mut first = connect(Arc::clone(&config), listener.addr, localhost())
        .await
        .unwrap();
    assert_eq!(request_on(&mut first, "/protected").await.unwrap().0, 200);
    let mut resumed = connect(Arc::clone(&config), listener.addr, localhost())
        .await
        .unwrap();
    assert_eq!(
        resumed.get_ref().1.protocol_version(),
        Some(rustls::ProtocolVersion::TLSv1_2)
    );
    assert_eq!(
        resumed.get_ref().1.handshake_kind(),
        Some(rustls::HandshakeKind::Resumed)
    );
    assert_eq!(request_on(&mut resumed, "/protected").await.unwrap().0, 200);

    let tcp = tokio::net::TcpStream::connect(listener.addr).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while listener.counters.handshakes_started() < 3 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the old TLS 1.2 acceptor was captured");
    let owner = gens.source_owner();
    gens.claim_source(&owner).unwrap();
    assert!(tokio_rustls::TlsConnector::from(config)
        .connect(localhost(), tcp)
        .await
        .is_err());
}
