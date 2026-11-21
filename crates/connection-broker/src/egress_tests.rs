use super::*;

fn token() -> TokenSet {
    TokenSet {
        access_token: "do-not-return".into(),
        refresh_token: None,
        token_type: "test".into(),
        expires_at: None,
        scopes: Vec::new(),
        configuration: std::collections::BTreeMap::default(),
    }
}

#[test]
fn places_oauth_and_api_key_credentials_from_catalog_auth() {
    let oauth = AuthMethod::OpenRouterPkce {
        authorize_url: "https://openrouter.ai/auth".into(),
        exchange_url: "https://openrouter.ai/api/v1/auth/keys".into(),
    };
    assert_eq!(
        credential_header(&oauth, &token()).unwrap(),
        ("Authorization".into(), "Bearer do-not-return".into())
    );

    let api_key = AuthMethod::ApiKey {
        header: "X-Api-Key".into(),
        value_prefix: "Key ".into(),
    };
    assert_eq!(
        credential_header(&api_key, &token()).unwrap(),
        ("X-Api-Key".into(), "Key do-not-return".into())
    );
    assert!(credential_header(&AuthMethod::Configuration, &token()).is_err());
}

#[test]
fn parses_private_repo() {
    let v = json!({
        "name": "opensesame-passwords",
        "full_name": "alice/opensesame-passwords",
        "private": true,
        "clone_url": "https://github.com/alice/opensesame-passwords.git",
        "html_url": "https://github.com/alice/opensesame-passwords",
        "default_branch": "main"
    });
    let repo = parse_github_repo(&v).unwrap();
    assert!(repo.private);
    assert_eq!(repo.name, "opensesame-passwords");
    assert!(repo.clone_url.to_ascii_lowercase().ends_with(".git"));
}

#[test]
fn maps_integration_forbidden_to_actionable_hint() {
    let mapped = map_github_repo_create_error(BrokerError::ExchangeFailed(
        "upstream 403 Forbidden: {\"message\":\"Resource not accessible by integration\"}".into(),
    ));
    assert_eq!(mapped.code(), "invalid_request");
    assert!(mapped.hint().contains("Install the tenant GitHub App"));
    assert!(mapped.hint().contains("Re-authorize"));
}
