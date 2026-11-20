use opensesame_domain::transport::TransportPolicy;
use opensesame_invoke_through::{AuthStyle, EgressRule, InvokeRequest};
use secrecy::SecretString;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::*;
use crate::transport::ConnectorExecutionTarget;

#[tokio::test]
async fn web_pki_client_dials_the_checked_address_without_resolving_again() {
    // localhost normally resolves to 127.0.0.1 or ::1, not 127.0.0.2.
    let listener = tokio::net::TcpListener::bind("127.0.0.2:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        let length = stream.read(&mut request).await.unwrap();
        assert!(String::from_utf8_lossy(&request[..length]).contains("Bearer pinned-canary"));
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            .await
            .unwrap();
    });
    let transport = ConnectionTransport {
        policy: TransportPolicy::ServerTls,
        identity: None,
        trust: None,
        server_name: None,
        execution_target: ConnectorExecutionTarget::Host,
    };
    let authority = PinnedAuthority {
        label: format!("localhost:{}", address.port()),
        host: "localhost".into(),
        addrs: vec![address],
    };
    let rules = vec![EgressRule {
        provider_id: "github",
        scheme: "https",
        hosts: &["localhost"],
        auth: AuthStyle::Bearer,
    }];
    let invoker = build_invoker(&transport, None, None, &authority, rules, true).unwrap();
    let prepared = invoker
        .preflight(InvokeRequest {
            provider_id: "github".into(),
            method: "GET".into(),
            url: format!("http://localhost:{}/", address.port()),
            headers: vec![],
            body: None,
            subject: None,
            actor: None,
        })
        .unwrap();
    let response = invoker
        .execute(&SecretString::from("pinned-canary"), prepared)
        .await
        .unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(response.body.as_ref(), b"ok");
    server.await.unwrap();
}
