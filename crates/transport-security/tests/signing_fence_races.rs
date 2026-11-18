//! Explicit boundary for a session secret retrieved just before a claim.
mod common;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use common::{
    connect, generations, localhost, private_root, profile_fn, request_on, router, serve, Hits,
};
use opensesame_domain::transport::{TlsVersion, TransportPolicy};
use opensesame_transport_security::testkit::DisposableCa;
use opensesame_transport_security::{client_config, ClientProfile, ServerNamePolicy};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio_rustls::TlsConnector;

struct HeldFlight {
    addr: SocketAddr,
    observed: oneshot::Receiver<()>,
    release_flight: oneshot::Sender<()>,
    release_finished: oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}

async fn hold_resumed_flight(server_addr: SocketAddr) -> HeldFlight {
    let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_addr = proxy.local_addr().unwrap();
    let (flight_tx, flight_rx) = oneshot::channel();
    let (release_flight_tx, release_flight_rx) = oneshot::channel();
    let (release_finished_tx, release_finished_rx) = oneshot::channel();
    let forwarding = tokio::spawn(async move {
        let (client, _) = proxy.accept().await.unwrap();
        let server = TcpStream::connect(server_addr).await.unwrap();
        let (mut client_read, mut client_write) = client.into_split();
        let (mut server_read, mut server_write) = server.into_split();
        let upstream = async move {
            // Forward exactly the ClientHello record, then hold the client's
            // Finished until after the test observes its completed handshake.
            let mut header = [0_u8; 5];
            client_read.read_exact(&mut header).await.unwrap();
            assert_eq!(header[0], 22);
            let length = usize::from(u16::from_be_bytes([header[3], header[4]]));
            let mut body = vec![0_u8; length];
            client_read.read_exact(&mut body).await.unwrap();
            server_write.write_all(&header).await.unwrap();
            server_write.write_all(&body).await.unwrap();
            release_finished_rx.await.unwrap();
            let _ = tokio::io::copy(&mut client_read, &mut server_write).await;
        };
        let downstream = async move {
            let mut data = [0_u8; 16_384];
            let size = server_read.read(&mut data).await.unwrap();
            assert!(size > 0, "server produced no handshake flight");
            // Rustls has already selected the resumption secret before it can
            // emit ServerHello. Hold the flight while the source is claimed.
            flight_tx.send(()).unwrap();
            release_flight_rx.await.unwrap();
            client_write.write_all(&data[..size]).await.unwrap();
            let _ = tokio::io::copy(&mut server_read, &mut client_write).await;
        };
        tokio::join!(upstream, downstream);
    });
    HeldFlight {
        addr: proxy_addr,
        observed: flight_rx,
        release_flight: release_flight_tx,
        release_finished: release_finished_tx,
        task: forwarding,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn source_claim_after_session_retrieval_is_rejected_before_application_admission() {
    let server = DisposableCa::new("server");
    let ca = DisposableCa::new("clients");
    let gens = generations(server.issue_server("localhost").identity(), &ca);
    let listener = serve(
        Arc::clone(&gens),
        profile_fn(TransportPolicy::ServerTls),
        router(Arc::clone(&gens), Hits::default()),
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

    let held = hold_resumed_flight(listener.addr).await;
    let proxy_addr = held.addr;
    let client = tokio::spawn(async move {
        let tcp = TcpStream::connect(proxy_addr).await.unwrap();
        TlsConnector::from(config).connect(localhost(), tcp).await
    });
    tokio::time::timeout(Duration::from_secs(5), held.observed)
        .await
        .unwrap()
        .unwrap();
    let owner = gens.source_owner();
    gens.claim_source(&owner).unwrap();
    held.release_flight.send(()).unwrap();
    let mut client = tokio::time::timeout(Duration::from_secs(5), client)
        .await
        .unwrap()
        .unwrap()
        .expect("the client can complete a resumption already selected before claim");
    assert_eq!(
        client.get_ref().1.handshake_kind(),
        Some(rustls::HandshakeKind::Resumed)
    );
    held.release_finished.send(()).unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        request_on(&mut client, "/protected"),
    )
    .await
    .expect("stale connection must be refused promptly");
    assert!(result.is_err() || result.is_ok_and(|(status, _)| status == 403));
    held.task.abort();
}
