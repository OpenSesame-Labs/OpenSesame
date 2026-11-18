#![cfg(feature = "testkit")]

use axum::http::StatusCode;
use opensesame_domain::transport::{
    operations, BindingPurpose, BindingScope, PeerIdentitySelector, ServiceBinding,
    ServiceBindingSet, TrustProfileRef,
};
use opensesame_transport_security::testkit::DisposableCa;
use opensesame_worker::testkit::{start_local, start_mtls, CLIENT_TRUST_PROFILE};

fn binding() -> ServiceBindingSet {
    ServiceBindingSet {
        revision: 1,
        bindings: vec![ServiceBinding {
            id: "worker-client".into(),
            revision: 1,
            enabled: true,
            revoked: false,
            scope: BindingScope::Deployment,
            trust_profile: TrustProfileRef::new(CLIENT_TRUST_PROFILE).unwrap(),
            peer: PeerIdentitySelector::DnsName("host.test".into()),
            service_principal: "svc:host".into(),
            purpose: BindingPurpose::WorkerClient,
            allowed_operations: vec![operations::WORKER_PROVIDERS_LIST.into()],
            allowed_audiences: vec!["worker".into()],
            not_after: None,
            denied_thumbprints: vec![],
        }],
    }
}

async fn status(request: reqwest::RequestBuilder) -> StatusCode {
    request.send().await.unwrap().status()
}

async fn wait_for_release(address: std::net::SocketAddr) {
    loop {
        if tokio::net::TcpListener::bind(address).await.is_ok() {
            return;
        }
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn local_workers_use_real_auth_and_dispose_independently() {
    let mut first = start_local(&["encrypted-remote"], "test-token-a".into())
        .await
        .unwrap();
    let mut second = start_local(&["encrypted-remote"], "test-token-b".into())
        .await
        .unwrap();
    assert_ne!(first.address(), second.address());
    let client = reqwest::Client::builder()
        .no_proxy()
        .pool_max_idle_per_host(0)
        .build()
        .unwrap();
    let first_url = format!("{}/v1/providers", first.base_url());
    let second_url = format!("{}/v1/providers", second.base_url());
    assert_eq!(
        status(client.get(&first_url)).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        status(client.get(&first_url).bearer_auth("wrong")).await,
        StatusCode::UNAUTHORIZED
    );
    let allowed = client
        .get(&first_url)
        .bearer_auth("test-token-a")
        .send()
        .await
        .unwrap();
    assert_eq!(allowed.status(), StatusCode::OK);
    assert_eq!(
        allowed.json::<serde_json::Value>().await.unwrap(),
        serde_json::json!({"providers":["encrypted-remote"]})
    );
    assert_eq!(
        status(client.get(&second_url).bearer_auth("test-token-a")).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        status(client.get(&second_url).bearer_auth("test-token-b")).await,
        StatusCode::OK
    );
    assert_eq!(
        status(client.get(format!("{}/health/live", first.base_url()))).await,
        StatusCode::OK
    );
    assert_eq!(
        status(
            client
                .get(format!("{}/health/ready", first.base_url()))
                .bearer_auth("test-token-a")
        )
        .await,
        StatusCode::OK
    );
    assert_eq!(
        status(
            client
                .post(format!("{}/v1/invoke", first.base_url()))
                .bearer_auth("test-token-a")
        )
        .await,
        StatusCode::NOT_FOUND
    );

    let address = first.address();
    first.close().await.unwrap();
    first.close().await.unwrap();
    let rebound = tokio::net::TcpListener::bind(address).await.unwrap();
    drop(rebound);
    assert_eq!(
        status(client.get(&second_url).bearer_auth("test-token-b")).await,
        StatusCode::OK
    );
    second.close().await.unwrap();
}

#[tokio::test]
async fn dropping_a_fixture_stops_its_listener() {
    let address = {
        let worker = start_local(&["encrypted-remote"], "test-token".into())
            .await
            .unwrap();
        worker.address()
    };
    tokio::time::timeout(std::time::Duration::from_secs(2), wait_for_release(address))
        .await
        .expect("dropped worker should release its port");
}

#[tokio::test]
async fn mtls_requires_certificate_binding_and_operation() {
    let mut worker = start_mtls(&["encrypted-remote"], binding()).await.unwrap();
    let bound = worker.issue_client(PeerIdentitySelector::DnsName("host.test".into()));
    let stranger = worker.issue_client(PeerIdentitySelector::DnsName("other.test".into()));
    let url = format!("{}/v1/providers", worker.base_url());
    assert_eq!(
        worker
            .client(Some(&bound))
            .unwrap()
            .get(&url)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let denied = worker
        .client(Some(&stranger))
        .unwrap()
        .get(&url)
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        denied
            .headers()
            .get("x-opensesame-transport-error")
            .unwrap(),
        "peer_not_bound"
    );
    let missing_operation = worker
        .client(Some(&bound))
        .unwrap()
        .get(format!("{}/health/ready", worker.base_url()))
        .send()
        .await
        .unwrap();
    assert_eq!(missing_operation.status(), StatusCode::FORBIDDEN);
    assert!(worker
        .client(None)
        .unwrap()
        .get(&url)
        .bearer_auth("test-token-a")
        .send()
        .await
        .is_err());

    let foreign_ca = DisposableCa::new("foreign-test-ca");
    let foreign = foreign_ca.issue_client(PeerIdentitySelector::DnsName("host.test".into()));
    assert!(worker
        .client(Some(&foreign))
        .unwrap()
        .get(&url)
        .send()
        .await
        .is_err());
    let address = worker.address();
    worker.close().await.unwrap();
    worker.close().await.unwrap();
    let rebound = tokio::net::TcpListener::bind(address).await.unwrap();
    drop(rebound);
}

#[tokio::test]
async fn invalid_configuration_refuses_to_start_and_empty_bindings_deny() {
    assert!(start_local(&[], "test-token".into()).await.is_err());
    assert!(start_local(&["1password"], "test-token".into())
        .await
        .is_err());
    assert!(start_local(&["not-a-provider"], "test-token".into())
        .await
        .is_err());
    let mut invalid = binding();
    invalid.revision = 0;
    assert!(start_mtls(&["encrypted-remote"], invalid).await.is_err());

    let mut worker = start_mtls(&["encrypted-remote"], ServiceBindingSet::empty())
        .await
        .unwrap();
    let leaf = worker.issue_client(PeerIdentitySelector::DnsName("host.test".into()));
    let response = worker
        .client(Some(&leaf))
        .unwrap()
        .get(format!("{}/v1/providers", worker.base_url()))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    worker.close().await.unwrap();

    let mut no_token = start_local(&["encrypted-remote"], String::new())
        .await
        .unwrap();
    let response = reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .get(format!("{}/v1/providers", no_token.base_url()))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    no_token.close().await.unwrap();
}

#[tokio::test]
async fn live_provider_probes_are_refused_before_start() {
    // These probes would run real CLIs with ambient credentials. Neither
    // transport profile may start a listener that could invoke them.
    for provider in [
        "aws-secrets-manager",
        "azure-key-vault-secrets",
        "gcp-secret-manager",
    ] {
        let local_error = start_local(&[provider], "test-token".into())
            .await
            .err()
            .map(|error| error.to_string());
        assert_eq!(
            local_error.as_deref(),
            Some("worker testkit accepts only offline-safe providers")
        );
        let secure_error = start_mtls(&["encrypted-remote", provider], binding())
            .await
            .err()
            .map(|error| error.to_string());
        assert_eq!(
            secure_error.as_deref(),
            Some("worker testkit accepts only offline-safe providers")
        );
    }
}
