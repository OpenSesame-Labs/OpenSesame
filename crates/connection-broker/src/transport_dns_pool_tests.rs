//! DNS rotation must select a client pinned to this invocation's vetted set.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{routing::get, Router};
use opensesame_domain::transport::{
    IdentitySourceRef, PeerIdentitySelector, TransportPolicy, TrustProfileKind, TrustProfileRef,
};
use opensesame_invoke_through::{AuthStyle, EgressRule, InvokeRequest, Invoker};
use opensesame_transport_security::testkit::DisposableCa;
use opensesame_transport_security::{
    GenerationCandidate, SecureListener, ServerProfile, TlsIdentity, TransportGenerations,
    TrustBundle,
};
use secrecy::SecretString;

use super::*;
use crate::transport::{ConnectorExecutionTarget, ServerNameSelector};

fn rules() -> Vec<EgressRule> {
    vec![EgressRule {
        provider_id: "acme",
        scheme: "https",
        hosts: &["localhost"],
        auth: AuthStyle::Bearer,
    }]
}

fn context() -> ConnectorContext {
    ConnectorContext {
        organization_id: "org-a".into(),
        connection_id: "connection-a".into(),
        provider_id: "acme".into(),
    }
}

fn authority(addrs: &[SocketAddr]) -> PinnedAuthority {
    PinnedAuthority {
        label: format!("localhost:{}", addrs[0].port()),
        host: "localhost".into(),
        addrs: addrs.to_vec(),
    }
}

fn pooled(
    pool: &ConnectorClientPool,
    authority: &PinnedAuthority,
    transport: &ConnectionTransport,
    identity: Option<&Arc<TlsIdentity>>,
    trust: Option<&Arc<TrustBundle>>,
) -> Arc<Invoker> {
    let trust_generation = trust.map_or(0, |bundle| bundle.generation());
    let key = pool_key(&context(), transport, identity, trust_generation, authority);
    pool.get_or_build_pinned(&key, &authority.addrs, || {
        build_invoker(transport, identity, trust, authority, rules(), true)
    })
    .unwrap()
}

async fn send(invoker: &Invoker, port: u16, scheme: &str) -> String {
    let prepared = invoker
        .preflight(InvokeRequest {
            provider_id: "acme".into(),
            method: "GET".into(),
            url: format!("{scheme}://localhost:{port}/"),
            headers: vec![],
            body: None,
            subject: None,
            actor: None,
        })
        .unwrap();
    let response = invoker
        .execute(&SecretString::from("rotation-canary"), prepared)
        .await
        .unwrap();
    assert_eq!(response.status, 200);
    String::from_utf8(response.body.to_vec()).unwrap()
}

fn web_pki_transport() -> ConnectionTransport {
    ConnectionTransport {
        policy: TransportPolicy::ServerTls,
        identity: None,
        trust: None,
        server_name: None,
        execution_target: ConnectorExecutionTarget::Host,
    }
}

#[test]
fn dns_order_and_duplicate_answers_do_not_change_the_scope() {
    let a = "1.1.1.1:443".parse().unwrap();
    let b = "8.8.8.8:443".parse().unwrap();
    let pool = ConnectorClientPool::with_capacity(4);
    let transport = web_pki_transport();
    let both = pooled(&pool, &authority(&[a, b]), &transport, None, None);
    let reordered = pooled(&pool, &authority(&[b, a, a]), &transport, None, None);
    assert!(Arc::ptr_eq(&both, &reordered));
    let only_a = pooled(&pool, &authority(&[a]), &transport, None, None);
    let only_b = pooled(&pool, &authority(&[b]), &transport, None, None);
    assert!(!Arc::ptr_eq(&both, &only_a));
    assert!(!Arc::ptr_eq(&only_a, &only_b));
}

#[tokio::test]
async fn web_pki_pool_moves_to_the_new_dns_answer_and_reuses_identical_answers() {
    let a = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let a_addr = a.local_addr().unwrap();
    let b = tokio::net::TcpListener::bind(format!("127.0.0.2:{}", a_addr.port()))
        .await
        .unwrap();
    let b_addr = b.local_addr().unwrap();
    let a_server = tokio::spawn(async move {
        axum::serve(a, Router::new().route("/", get(|| async { "A" })))
            .await
            .unwrap();
    });
    let b_server = tokio::spawn(async move {
        axum::serve(b, Router::new().route("/", get(|| async { "B" })))
            .await
            .unwrap();
    });

    let pool = ConnectorClientPool::with_capacity(4);
    let transport = web_pki_transport();
    let first = pooled(&pool, &authority(&[a_addr]), &transport, None, None);
    assert_eq!(send(&first, a_addr.port(), "http").await, "A");
    let same = pooled(&pool, &authority(&[a_addr, a_addr]), &transport, None, None);
    assert!(Arc::ptr_eq(&first, &same));

    let rotated = pooled(&pool, &authority(&[b_addr]), &transport, None, None);
    assert!(!Arc::ptr_eq(&first, &rotated));
    assert_eq!(send(&rotated, a_addr.port(), "http").await, "B");
    assert!(Arc::ptr_eq(
        &rotated,
        &pooled(&pool, &authority(&[b_addr]), &transport, None, None)
    ));
    a_server.abort();
    b_server.abort();
}

async fn mtls_listener(
    address: SocketAddr,
    generations: Arc<TransportGenerations>,
    trust: Arc<TrustBundle>,
    response: &'static str,
) -> (SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = SecureListener::bind(address, generations, move |generation| {
        let mut profile = ServerProfile::new(
            TransportPolicy::MtlsRequired,
            Arc::clone(generation.identity.as_ref().unwrap()),
            "dns-pool-test",
        );
        profile.client_trust = Some(trust.as_ref().clone());
        Ok(profile)
    })
    .await
    .unwrap();
    let addr = listener.local_addr();
    let task = tokio::spawn(async move {
        listener
            .serve(Router::new().route("/", get(move || async move { response })))
            .await
            .unwrap();
    });
    (addr, task)
}

#[tokio::test]
async fn mtls_pool_moves_to_the_new_dns_answer_and_reuses_identical_answers() {
    let ca = DisposableCa::new("connector-dns-test");
    let server = ca.issue_server("localhost");
    let client = ca.issue_client(PeerIdentitySelector::DnsName("client.example".into()));
    let trust = Arc::new(
        TrustBundle::from_pem(
            TrustProfileRef::new("test-ca").unwrap(),
            TrustProfileKind::PrivateRoot,
            &ca.root_pem(),
        )
        .unwrap(),
    );
    let generation = GenerationCandidate {
        identity: Some(Arc::new(server.identity())),
        identity_required: true,
        ..GenerationCandidate::default()
    }
    .into_generation(1, opensesame_time::Utc::now())
    .unwrap();
    let generations = TransportGenerations::new(generation);
    let (a, a_server) = mtls_listener(
        "127.0.0.1:0".parse().unwrap(),
        Arc::clone(&generations),
        Arc::clone(&trust),
        "A",
    )
    .await;
    let (b, b_server) = mtls_listener(
        format!("127.0.0.2:{}", a.port()).parse().unwrap(),
        generations,
        Arc::clone(&trust),
        "B",
    )
    .await;
    let identity = Arc::new(client.identity());
    let transport = ConnectionTransport {
        policy: TransportPolicy::MtlsRequired,
        identity: Some(IdentitySourceRef::new("client").unwrap()),
        trust: Some(TrustProfileRef::new("test-ca").unwrap()),
        server_name: Some(ServerNameSelector::Dns("localhost".into())),
        execution_target: ConnectorExecutionTarget::Host,
    };
    let pool = ConnectorClientPool::with_capacity(4);
    let first = pooled(
        &pool,
        &authority(&[a]),
        &transport,
        Some(&identity),
        Some(&trust),
    );
    assert_eq!(send(&first, a.port(), "https").await, "A");
    let same = pooled(
        &pool,
        &authority(&[a, a]),
        &transport,
        Some(&identity),
        Some(&trust),
    );
    assert!(Arc::ptr_eq(&first, &same));
    let rotated = pooled(
        &pool,
        &authority(&[b]),
        &transport,
        Some(&identity),
        Some(&trust),
    );
    assert!(!Arc::ptr_eq(&first, &rotated));
    assert_eq!(send(&rotated, a.port(), "https").await, "B");
    assert!(Arc::ptr_eq(
        &rotated,
        &pooled(
            &pool,
            &authority(&[b]),
            &transport,
            Some(&identity),
            Some(&trust)
        )
    ));
    a_server.abort();
    b_server.abort();
}
