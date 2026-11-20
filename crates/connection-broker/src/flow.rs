//! Authorization-code flow with PKCE S256 — always, including for confidential
//! clients (ADR 0032 §4).

use std::env;

use oauth2::{CsrfToken, PkceCodeChallenge};
use sha2::{Digest, Sha256};
use url::Url;

use opensesame_invoke_through::scrub_credential_reflections;

use crate::catalog::{AuthMethod, Provider, TokenAuth};
use crate::config::BrokerConfig;
use crate::error::{BrokerError, Result};
use crate::response_guard::{read_bounded_body, safe_oauth_error_detail, transport_detail};
#[cfg(test)]
use crate::response_guard::oauth_error_detail;
use crate::token::TokenResponse;

/// A `state` outlives a human deciding whether to consent, and no longer.
pub const STATE_TTL_SECONDS: i64 = 600;

/// Provider-controlled token response bodies are bounded before allocation.
const MAX_TOKEN_RESPONSE_BYTES: usize = 256 * 1024;

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

pub const CHALLENGE_METHOD: &str = "S256";

impl Pkce {
    #[must_use]
    pub fn generate() -> Self {
        let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
        Self {
            verifier: verifier.secret().clone(),
            challenge: challenge.as_str().to_string(),
        }
    }

    /// The challenge a verifier must produce, per RFC 7636 §4.2. Computed here
    /// rather than through `oauth2`, whose constructor panics on a verifier of the
    /// wrong length — this is also used to check verifiers we did not generate.
    #[must_use]
    pub fn challenge_for(verifier: &str) -> String {
        use base64::Engine;
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
    }
}

/// 32 bytes of CSPRNG output; a guessable `state` is a session-fixation hole.
#[must_use]
pub fn new_state() -> String {
    CsrfToken::new_random_len(32).secret().clone()
}

/// Mirrors the gateway's production check rather than importing the binary crate.
#[must_use]
pub fn is_production_env() -> bool {
    env::var("OPENSESAME_ENV").ok().as_deref() == Some("production")
        || env::var("NODE_ENV").ok().as_deref() == Some("production")
}

fn is_loopback(url: &Url) -> bool {
    matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1"))
}

/// Tokens and codes only travel over TLS. Loopback is the single exception, and
/// only outside production, so the bundled mock authorization server works.
///
/// # Errors
///
/// Returns an error for malformed or disallowed transport URLs.
pub fn assert_transport_allowed(raw: &str) -> Result<Url> {
    let url = Url::parse(raw).map_err(|_| BrokerError::Invalid(format!("malformed url {raw}")))?;
    match url.scheme() {
        "https" => Ok(url),
        "http" if is_loopback(&url) && !is_production_env() => Ok(url),
        _ => Err(BrokerError::Invalid(format!(
            "{} endpoints must be https",
            url.scheme()
        ))),
    }
}

#[derive(Clone, Copy)]
pub struct AuthorizeParams<'a> {
    pub client_id: &'a str,
    pub redirect_uri: &'a str,
    pub scopes: &'a [String],
    pub state: &'a str,
    pub code_challenge: &'a str,
}

/// # Errors
///
/// Returns an error when the provider does not support authorization or its
/// endpoint or redirect URI is invalid.
pub fn build_authorize_url(
    provider: &Provider,
    config: &BrokerConfig,
    params: AuthorizeParams<'_>,
) -> Result<String> {
    let AuthorizeParams {
        client_id,
        redirect_uri,
        scopes,
        state,
        code_challenge,
    } = params;
    if matches!(&provider.auth, AuthMethod::OpenRouterPkce { .. }) {
        let raw = config
            .authorize_url(provider)
            .ok_or_else(|| BrokerError::UnsupportedCredential(provider.id.to_string()))?;
        let mut url = assert_transport_allowed(&raw)?;
        let mut callback = Url::parse(redirect_uri).map_err(|_| BrokerError::RedirectNotAllowed)?;
        callback.query_pairs_mut().append_pair("state", state);
        url.query_pairs_mut()
            .append_pair("callback_url", callback.as_str())
            .append_pair("code_challenge", code_challenge)
            .append_pair("code_challenge_method", CHALLENGE_METHOD);
        return Ok(url.to_string());
    }
    let AuthMethod::OAuth2AuthCode {
        extra_authorize_params,
        ..
    } = &provider.auth
    else {
        return Err(BrokerError::UnsupportedCredential(provider.id.to_string()));
    };
    let raw = config
        .authorize_url(provider)
        .ok_or_else(|| BrokerError::UnsupportedCredential(provider.id.to_string()))?;
    let mut url = assert_transport_allowed(&raw)?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("response_type", "code");
        q.append_pair("client_id", client_id);
        q.append_pair("redirect_uri", redirect_uri);
        q.append_pair("state", state);
        q.append_pair("code_challenge", code_challenge);
        q.append_pair("code_challenge_method", CHALLENGE_METHOD);
        if !scopes.is_empty() {
            q.append_pair("scope", &scopes.join(provider.auth.scope_separator()));
        }
        for (k, v) in extra_authorize_params {
            q.append_pair(k, v);
        }
    }
    Ok(url.to_string())
}

/// # Errors
///
/// Returns an error when the provider exchange is unsupported or fails.
pub async fn exchange_code(
    http: &reqwest::Client,
    provider: &Provider,
    config: &BrokerConfig,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<TokenResponse> {
    if matches!(&provider.auth, AuthMethod::OpenRouterPkce { .. }) {
        return exchange_openrouter_key(http, provider, config, code, code_verifier).await;
    }
    let form = vec![
        ("grant_type".to_string(), "authorization_code".to_string()),
        ("code".to_string(), code.to_string()),
        ("redirect_uri".to_string(), redirect_uri.to_string()),
        ("code_verifier".to_string(), code_verifier.to_string()),
    ];
    post_token_endpoint(http, provider, config, form).await
}

#[derive(serde::Deserialize)]
struct OpenRouterKeyResponse {
    key: String,
}

async fn exchange_openrouter_key(
    http: &reqwest::Client,
    provider: &Provider,
    config: &BrokerConfig,
    code: &str,
    code_verifier: &str,
) -> Result<TokenResponse> {
    let raw = config
        .token_url(provider)
        .ok_or_else(|| BrokerError::UnsupportedCredential(provider.id.to_string()))?;
    let mut response = http
        .post(assert_transport_allowed(&raw)?)
        .header("Accept", "application/json")
        .json(&serde_json::json!({
            "code": code,
            "code_verifier": code_verifier,
            "code_challenge_method": CHALLENGE_METHOD,
        }))
        .send()
        .await
        .map_err(|error| BrokerError::ExchangeFailed(transport_detail(&error)))?;
    if !response.status().is_success() {
        return Err(BrokerError::ExchangeFailed(format!(
            "provider returned {}",
            response.status().as_u16()
        )));
    }
    let body = read_bounded_body(&mut response, MAX_TOKEN_RESPONSE_BYTES)
        .await
        .map_err(|error| BrokerError::ExchangeFailed(error.to_string()))?;
    let (body, reflected) = scrub_credential_reflections(body, &[code, code_verifier]);
    if reflected {
        return Err(BrokerError::ExchangeFailed(
            "token response reflected submitted authorization material".into(),
        ));
    }
    parse_openrouter_key(&body)
}

fn parse_openrouter_key(body: &[u8]) -> Result<TokenResponse> {
    let body: OpenRouterKeyResponse = serde_json::from_slice(body)
        .map_err(|_| BrokerError::ExchangeFailed("token response was not understood".into()))?;
    if body.key.trim().is_empty() {
        return Err(BrokerError::ExchangeFailed(
            "token response was not understood".into(),
        ));
    }
    Ok(TokenResponse {
        access_token: body.key,
        refresh_token: None,
        token_type: Some("Bearer".into()),
        expires_in: None,
        scope: None,
        id_token: None,
    })
}

/// POSTs to the provider's token endpoint honouring its client authentication.
/// The response body is never echoed into an error: on the success path it holds
/// the tokens themselves.
/// Provider bytes are bounded before allocation. Error details are limited to
/// the RFC code after every submitted value is scrubbed; success payloads are
/// parsed only as the declared token schema.
///
/// # Errors
///
/// Returns an error for invalid transport, missing client configuration, or a
/// failed or malformed provider response.
pub async fn post_token_endpoint(
    http: &reqwest::Client,
    provider: &Provider,
    config: &BrokerConfig,
    mut form: Vec<(String, String)>,
) -> Result<TokenResponse> {
    let AuthMethod::OAuth2AuthCode { token_auth, .. } = &provider.auth else {
        return Err(BrokerError::UnsupportedCredential(provider.id.to_string()));
    };
    let raw = config
        .token_url(provider)
        .ok_or_else(|| BrokerError::UnsupportedCredential(provider.id.to_string()))?;
    let url = assert_transport_allowed(&raw)?;

    let provider_config = config.provider(&provider.id);
    let missing = config.missing_config(provider);
    if !missing.is_empty() {
        return Err(BrokerError::ProviderUnconfigured {
            provider: provider.id.to_string(),
            missing,
        });
    }
    let (Some(client_id), Some(client_secret)) =
        (provider_config.client_id, provider_config.client_secret)
    else {
        return Err(BrokerError::ProviderUnconfigured {
            provider: provider.id.to_string(),
            missing: config.missing_config(provider),
        });
    };
    let client_secret_for_scrub = client_secret.clone();

    let guarded = if provider.id.starts_with(crate::CUSTOM_PROVIDER_PREFIX) {
        config.custom_egress().validate_token(provider, &url)?;
        Some(
            config
                .custom_egress()
                .client(&url, std::time::Duration::from_secs(20))
                .await?,
        )
    } else {
        None
    };
    let mut request = guarded
        .as_ref()
        .unwrap_or(http)
        .post(url)
        .header("Accept", "application/json");
    match *token_auth {
        TokenAuth::ClientSecretBasic => {
            request = request.basic_auth(&client_id, Some(&client_secret));
            form.push(("client_id".to_string(), client_id));
        }
        TokenAuth::ClientSecretPost => {
            form.push(("client_id".to_string(), client_id));
            form.push(("client_secret".to_string(), client_secret));
        }
    }

    let mut response = request
        .form(&form)
        .send()
        .await
        .map_err(|e| BrokerError::ExchangeFailed(transport_detail(&e)))?;
    let status = response.status();
    let body = read_bounded_body(&mut response, MAX_TOKEN_RESPONSE_BYTES)
        .await
        .map_err(|error| BrokerError::ExchangeFailed(error.to_string()))?;
    let mut submitted: Vec<&str> = form.iter().map(|(_, value)| value.as_str()).collect();
    submitted.push(&client_secret_for_scrub);

    if !status.is_success() {
        // Error diagnostics may quote only the RFC error code, and only after
        // every submitted form value plus the HTTP Basic secret has been
        // scrubbed. This covers authorization codes, PKCE verifiers, refresh
        // tokens and future credential-like form fields without naming them.
        let detail = safe_oauth_error_detail(body, &submitted)?;
        return Err(BrokerError::ExchangeFailed(format!(
            "provider returned {}{}",
            status.as_u16(),
            detail.map(|d| format!(" ({d})")).unwrap_or_default()
        )));
    }
    let body = String::from_utf8(body.to_vec())
        .map_err(|_| BrokerError::ExchangeFailed("token response was not valid UTF-8".into()))?;
    match serde_json::from_str::<TokenResponse>(&body) {
        Ok(response) => Ok(response),
        Err(_) => {
            let detail = safe_oauth_error_detail(bytes::Bytes::from(body), &submitted)?
                .unwrap_or_else(|| "token response was not understood".to_string());
            Err(BrokerError::ExchangeFailed(detail))
        }
    }
}

/// Best-effort upstream revocation. A provider that refuses is recorded, not fatal:
/// the connection is revoked here either way.
///
/// # Errors
///
/// Returns an error when revocation is unsupported, misconfigured, or refused.
pub async fn revoke_upstream(
    http: &reqwest::Client,
    provider: &Provider,
    config: &BrokerConfig,
    token: &str,
) -> Result<()> {
    let AuthMethod::OAuth2AuthCode {
        revoke_url: Some(revoke_url),
        token_auth,
        ..
    } = &provider.auth
    else {
        return Err(BrokerError::UnsupportedCredential(provider.id.to_string()));
    };
    let url = assert_transport_allowed(revoke_url)?;
    let provider_config = config.provider(&provider.id);
    let mut form = vec![("token".to_string(), token.to_string())];
    let mut request = http.post(url).header("Accept", "application/json");
    match (
        *token_auth,
        provider_config.client_id,
        provider_config.client_secret,
    ) {
        (TokenAuth::ClientSecretBasic, Some(id), Some(secret)) => {
            request = request.basic_auth(id, Some(secret));
        }
        (TokenAuth::ClientSecretPost, Some(id), Some(secret)) => {
            form.push(("client_id".to_string(), id));
            form.push(("client_secret".to_string(), secret));
        }
        _ => {
            return Err(BrokerError::ProviderUnconfigured {
                provider: provider.id.to_string(),
                missing: config.missing_config(provider),
            })
        }
    }
    let response = request
        .form(&form)
        .send()
        .await
        .map_err(|e| BrokerError::ExchangeFailed(transport_detail(&e)))?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(BrokerError::ExchangeFailed(format!(
            "revocation returned {}",
            response.status().as_u16()
        )))
    }
}

#[cfg(test)]
#[path = "flow_tests.rs"]
mod tests;
