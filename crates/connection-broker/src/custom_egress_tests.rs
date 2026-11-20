use super::*;
use crate::custom_provider::{derive_provider, CreateCustomProvider, CustomAuthSpec};

fn provider(base: &str, token: &str) -> Provider {
    derive_provider(&CreateCustomProvider {
        id: "custom-example".into(),
        display_name: "Example".into(),
        base_url: base.into(),
        docs_url: None,
        auth: CustomAuthSpec::Oauth2AuthorizationCode {
            authorize_url: "https://login.example/authorize".into(),
            token_url: token.into(),
            supports_refresh: true,
            scopes: vec![],
        },
    })
    .unwrap()
}

#[test]
fn operator_allowlists_are_exact_https_origins() {
    for bad in [
        "http://private.example",
        "https://user@private.example",
        "https://private.example/path",
        "https://private.example/?x=1",
        "https://private.example/#part",
        "not-a-url",
    ] {
        assert!(
            CustomEgressPolicy::new(&[bad.into()], &[]).is_err(),
            "{bad}"
        );
    }
    let policy = CustomEgressPolicy::new(&["https://PRIVATE.example:8443/".into()], &[]).unwrap();
    assert!(policy.private_allowed(&Url::parse("https://private.example:8443/v1").unwrap()));
    assert!(!policy.private_allowed(&Url::parse("https://private.example:8444/v1").unwrap()));
    assert!(!policy.private_allowed(&Url::parse("https://other.example:8443/v1").unwrap()));
}

#[test]
fn token_endpoints_require_the_base_or_an_operator_approved_origin() {
    let same = provider("https://api.example/v1", "https://api.example/oauth/token");
    let cross = provider(
        "https://api.example/v1",
        "https://login.example/oauth/token",
    );
    let default = CustomEgressPolicy::default();
    assert!(default.validate_provider(&same).is_ok());
    assert!(default.validate_provider(&cross).is_err());
    let approved = CustomEgressPolicy::new(&[], &["https://login.example".into()]).unwrap();
    assert!(approved.validate_provider(&cross).is_ok());
    let other_port = Url::parse("https://login.example:8443/oauth/token").unwrap();
    assert!(approved.validate_token(&cross, &other_port).is_err());
}

#[test]
fn every_dns_answer_is_vetted_and_private_consent_is_origin_scoped() {
    let url = Url::parse("https://vault.example:8443/v1").unwrap();
    let public: SocketAddr = "8.8.8.8:8443".parse().unwrap();
    let policy = CustomEgressPolicy::default();
    assert!(policy.vet(&url, &[public]).is_ok());
    for blocked in [
        "127.0.0.1:8443",
        "10.1.2.3:8443",
        "169.254.169.254:8443",
        "100.64.0.1:8443",
        "198.18.0.1:8443",
        "[::ffff:127.0.0.1]:8443",
        "[64:ff9b::7f00:1]:8443",
        "[2002:a9fe:a9fe::1]:8443",
        "[64:ff9b:1::1]:8443",
        "[fec0::1]:8443",
        "[2001::1]:8443",
        "[3fff::1]:8443",
    ] {
        let private = blocked.parse().unwrap();
        assert!(policy.vet(&url, &[public, private]).is_err(), "{blocked}");
    }
    assert!(policy.vet(&url, &[]).is_err());
    assert!(policy
        .vet(&url, &vec![public; MAX_DNS_ANSWERS + 1])
        .is_err());
    let approved = CustomEgressPolicy::new(&["https://vault.example:8443".into()], &[]).unwrap();
    assert!(approved
        .vet(&url, &["10.1.2.3:8443".parse().unwrap()])
        .is_ok());
    let other_port = Url::parse("https://vault.example:8444/v1").unwrap();
    assert!(approved
        .vet(&other_port, &["10.1.2.3:8444".parse().unwrap()])
        .is_err());
    assert!(approved
        .vet(&url, &["0.0.0.0:8443".parse().unwrap()])
        .is_err());
}

#[tokio::test]
async fn private_dns_needs_explicit_operator_consent() {
    let url = Url::parse("https://localhost:8443/v1").unwrap();
    assert!(CustomEgressPolicy::default()
        .client(&url, Duration::from_secs(1))
        .await
        .is_err());
    let approved = CustomEgressPolicy::new(&["https://localhost:8443".into()], &[]).unwrap();
    assert!(approved.client(&url, Duration::from_secs(1)).await.is_ok());
}

#[tokio::test]
async fn oauth_exchange_refuses_private_dns_before_sending_client_secrets() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let base = format!("https://localhost:{port}");
    let provider = provider(&base, &format!("{base}/token"));
    let config = crate::BrokerConfig::in_memory(Some([7; 32]), "http://127.0.0.1").with_provider(
        &provider.id,
        crate::ProviderConfig {
            client_id: Some("client-id".into()),
            client_secret: Some("client-secret-canary".into()),
            ..Default::default()
        },
    );
    let error =
        crate::flow::post_token_endpoint(&reqwest::Client::new(), &provider, &config, vec![])
            .await
            .unwrap_err();
    assert!(error.to_string().contains("private"));
    assert!(!error.to_string().contains("client-secret-canary"));
    assert!(
        tokio::time::timeout(Duration::from_millis(250), listener.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn the_client_dials_only_the_checked_dns_answer() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let url = Url::parse(&format!(
        "https://unresolvable.invalid:{}/v1",
        address.port()
    ))
    .unwrap();
    let approved = CustomEgressPolicy::new(&[url.origin().ascii_serialization()], &[]).unwrap();
    let client = approved
        .build_client(&url, &[address], Duration::from_secs(1))
        .unwrap();
    let request = tokio::spawn(async move { client.get(url).send().await });
    // No DNS record exists for this hostname. A connection here demonstrates
    // the checked answer was used instead of resolving it again or a proxy.
    let (stream, _) = tokio::time::timeout(Duration::from_secs(3), listener.accept())
        .await
        .expect("pinned address was not dialed")
        .unwrap();
    drop(stream);
    assert!(request.await.unwrap().is_err()); // the fixture did not perform TLS
}
