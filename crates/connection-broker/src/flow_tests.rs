use super::*;
use crate::catalog;
use crate::config::ProviderConfig;
use base64::Engine;

fn config() -> BrokerConfig {
    BrokerConfig::in_memory(Some([3u8; 32]), "http://127.0.0.1:8787").with_provider(
        "github",
        ProviderConfig {
            client_id: Some("client-id".into()),
            client_secret: Some("client-secret".into()),
            ..Default::default()
        },
    )
}

#[test]
fn verifier_is_high_entropy_and_within_rfc_bounds() {
    let a = Pkce::generate();
    let b = Pkce::generate();
    assert_ne!(a.verifier, b.verifier);
    assert!(
        (43..=128).contains(&a.verifier.len()),
        "{}",
        a.verifier.len()
    );
    assert!(a
        .verifier
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "-._~".contains(c)));
}

/// The challenge must be exactly base64url(sha256(verifier)), unpadded.
#[test]
fn challenge_is_s256_of_the_verifier() {
    let pkce = Pkce::generate();
    let expected = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(pkce.verifier.as_bytes()));
    assert_eq!(pkce.challenge, expected);
    assert_eq!(Pkce::challenge_for(&pkce.verifier), pkce.challenge);
    assert_ne!(Pkce::challenge_for("some-other-verifier"), pkce.challenge);
}

#[test]
fn state_is_unguessable_and_unique() {
    let a = new_state();
    let b = new_state();
    assert_ne!(a, b);
    assert!(a.len() >= 43, "{}", a.len());
}

#[test]
fn authorize_url_carries_the_whole_pkce_request() {
    let github = catalog::find("github").expect("catalog").expect("github");
    let scopes = vec!["read:user".to_string(), "repo".to_string()];
    let url = build_authorize_url(
        github,
        &config(),
        AuthorizeParams {
            client_id: "client-id",
            redirect_uri: "http://127.0.0.1:8787/api/v1/oauth/callback/github",
            scopes: &scopes,
            state: "st-1",
            code_challenge: "chal",
        },
    )
    .unwrap();
    let parsed = Url::parse(&url).unwrap();
    let q: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
    assert_eq!(q["response_type"], "code");
    assert_eq!(q["client_id"], "client-id");
    assert_eq!(q["state"], "st-1");
    assert_eq!(q["code_challenge"], "chal");
    assert_eq!(q["code_challenge_method"], "S256");
    assert_eq!(q["scope"], "read:user repo");
    assert_eq!(
        q["redirect_uri"],
        "http://127.0.0.1:8787/api/v1/oauth/callback/github"
    );
}

#[test]
fn google_asks_for_offline_consent() {
    let google = catalog::find("google").expect("catalog").expect("google");
    let cfg = config().with_provider(
        "google",
        ProviderConfig {
            client_id: Some("id".into()),
            client_secret: Some("secret".into()),
            ..Default::default()
        },
    );
    let url = build_authorize_url(
        google,
        &cfg,
        AuthorizeParams {
            client_id: "id",
            redirect_uri: "https://app.example/cb",
            scopes: &[],
            state: "s",
            code_challenge: "c",
        },
    )
    .unwrap();
    assert!(url.contains("access_type=offline"));
    assert!(url.contains("prompt=consent"));
    assert!(!url.contains("scope="));
}

#[test]
fn provider_scope_separator_is_honored() {
    let linear = catalog::find("linear").expect("catalog").expect("linear");
    let scopes = vec!["read".to_string(), "write".to_string()];
    let url = build_authorize_url(
        linear,
        &config(),
        AuthorizeParams {
            client_id: "id",
            redirect_uri: "https://app.example/cb",
            scopes: &scopes,
            state: "s",
            code_challenge: "c",
        },
    )
    .unwrap();
    let parsed = Url::parse(&url).unwrap();
    let q: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
    assert_eq!(q["scope"], "read,write");
}

#[test]
fn openrouter_pkce_needs_no_app_secret() {
    let provider = catalog::find("openrouter")
        .expect("catalog")
        .expect("openrouter");
    let cfg = BrokerConfig::in_memory(Some([3u8; 32]), "http://127.0.0.1:8787");
    let url = build_authorize_url(
        provider,
        &cfg,
        AuthorizeParams {
            client_id: "",
            redirect_uri: "http://127.0.0.1:8787/api/v1/oauth/callback/openrouter",
            scopes: &[],
            state: "state-1",
            code_challenge: "challenge-1",
        },
    )
    .unwrap();
    let query: std::collections::HashMap<_, _> = Url::parse(&url)
        .unwrap()
        .query_pairs()
        .into_owned()
        .collect();
    assert_eq!(query["code_challenge"], "challenge-1");
    assert_eq!(query["code_challenge_method"], "S256");
    assert_eq!(
        query["callback_url"],
        "http://127.0.0.1:8787/api/v1/oauth/callback/openrouter?state=state-1"
    );
    assert!(!query.contains_key("client_id"));
    assert!(cfg.missing_config(provider).is_empty());

    let response = parse_openrouter_key(br#"{"key":"sk-or-v1-secret"}"#).unwrap();
    assert_eq!(response.access_token, "sk-or-v1-secret");
    assert_eq!(response.token_type.as_deref(), Some("Bearer"));
    assert!(parse_openrouter_key(br#"{"access_token":"wrong-shape"}"#).is_err());
}

#[test]
fn api_key_providers_have_no_authorize_url() {
    let workos = catalog::find("workos").expect("catalog").expect("workos");
    let err = build_authorize_url(
        workos,
        &config(),
        AuthorizeParams {
            client_id: "id",
            redirect_uri: "https://app.example/cb",
            scopes: &[],
            state: "s",
            code_challenge: "c",
        },
    )
    .unwrap_err();
    assert_eq!(err.code(), "unsupported_credential");
}

#[test]
fn cleartext_is_refused_off_loopback() {
    assert!(assert_transport_allowed("https://example.com/token").is_ok());
    assert!(assert_transport_allowed("http://127.0.0.1:9090/token").is_ok());
    assert!(assert_transport_allowed("http://localhost:9090/token").is_ok());
    assert!(assert_transport_allowed("http://example.com/token").is_err());
    assert!(assert_transport_allowed("ftp://example.com/token").is_err());
    assert!(assert_transport_allowed("nonsense").is_err());
}

#[test]
fn error_detail_quotes_only_the_oauth_fields() {
    assert_eq!(
        oauth_error_detail(r#"{"error":"invalid_grant","error_description":"expired"}"#),
        Some("invalid_grant".to_string())
    );
    assert_eq!(
        oauth_error_detail(r#"{"error":"invalid_grant"}"#),
        Some("invalid_grant".to_string())
    );
    assert_eq!(oauth_error_detail(r#"{"access_token":"secret-abc"}"#), None);
    assert_eq!(
        oauth_error_detail(
            r#"{"error":"invalid_grant","error_description":"access_token=secret-abc"}"#
        ),
        Some("invalid_grant".to_string())
    );
    assert_eq!(oauth_error_detail(r#"{"error":"secret abc"}"#), None);
    assert_eq!(oauth_error_detail("not json"), None);
}
