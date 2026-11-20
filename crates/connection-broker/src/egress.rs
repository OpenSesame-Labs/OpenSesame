//! Host-mediated provider egress — inject sealed credentials, never return them.
//!
//! Used by capability setup (e.g. GitHub private password-store repos) so Pages
//! can list/create remotes after OAuth without seeing access tokens (ADR 0005/0032).

use opensesame_domain::OrganizationId;
use opensesame_invoke_through::scrub_credential_reflection;
use serde_json::{json, Value};
use std::time::Duration;

use crate::catalog::AuthMethod;
use crate::error::{BrokerError, Result};
use crate::model::ConnectionStatus;
use crate::response_guard::{read_bounded_body, ResponseBodyError};
use crate::store;
use crate::token::TokenSet;
use crate::ConnectionBroker;

#[path = "egress_client.rs"]
mod client;
use client::credentialed_client;

#[path = "egress_github.rs"]
mod github;
use github::{map_github_repo_create_error, parse_github_repo, parse_github_repo_list};

/// Characters of an upstream error body kept for diagnostics. A provider error
/// page is not worth holding in full, and the cap keeps a hostile upstream from
/// deciding how much of our memory its message occupies.
const MAX_ERROR_SNIPPET: usize = 512;
const MAX_JSON_RESPONSE_BYTES: usize = 1024 * 1024;

/// Headers the broker owns on a credentialed upload. A caller supplying any of
/// these would be competing with the injected credential or the framing of the
/// body, so they are refused rather than appended alongside.
const RESERVED_HEADERS: &[&str] = &[
    "authorization",
    "proxy-authorization",
    "content-type",
    "content-length",
    "host",
    "transfer-encoding",
];

fn credential_header(auth: &AuthMethod, tokens: &TokenSet) -> Result<(String, String)> {
    match auth {
        AuthMethod::OAuth2AuthCode { .. } | AuthMethod::OpenRouterPkce { .. } => Ok((
            "Authorization".into(),
            format!("Bearer {}", tokens.access_token),
        )),
        AuthMethod::ApiKey {
            header,
            value_prefix,
        } => Ok((
            header.clone(),
            format!("{value_prefix}{}", tokens.access_token),
        )),
        AuthMethod::Configuration => {
            Err(BrokerError::UnsupportedCredential("configuration".into()))
        }
    }
}

#[derive(Debug, Clone)]
pub struct GithubRepo {
    pub full_name: String,
    pub name: String,
    pub private: bool,
    pub clone_url: String,
    pub html_url: String,
    pub default_branch: String,
}

impl ConnectionBroker {
    /// Execute one catalog operation through the connection's sealed credential.
    ///
    /// This is the common constrained-HTTP adapter for OAuth and API-key
    /// providers. Configuration-only providers stay unavailable until a typed
    /// adapter owns their local or provider-specific protocol.
    ///
    /// # Errors
    ///
    /// Returns an error when the operation, method, provider adapter, egress,
    /// credential, or upstream response is invalid.
    pub async fn invoke_network_json(
        &self,
        organization_id: &OrganizationId,
        connection_id: &str,
        operation: &str,
        method: &str,
        url: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        let row = self.row_in_org(organization_id, connection_id).await?;
        let provider = self
            .resolve_provider(&row.organization_id, &row.provider_id)
            .await?;
        if matches!(&provider.auth, AuthMethod::Configuration) {
            return Err(BrokerError::UnsupportedCredential(provider.id));
        }
        if !provider
            .operations
            .iter()
            .any(|candidate| candidate == operation)
        {
            return Err(BrokerError::Invalid(format!(
                "provider `{}` does not implement operation `{operation}`",
                provider.id
            )));
        }
        if !matches!(
            method.to_ascii_uppercase().as_str(),
            "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD"
        ) {
            return Err(BrokerError::Invalid(format!(
                "method `{method}` is not allowed"
            )));
        }
        self.authorized_json(organization_id, connection_id, method, url, body)
            .await
    }

    /// GET <https://api.github.com/user/repos> (authenticated).
    /// Prefer repositories the user owns so History can pick a personal password store.
    ///
    /// # Errors
    ///
    /// Returns an error when authorization, egress, upstream, or response validation fails.
    pub async fn list_github_repos(
        &self,
        organization_id: &OrganizationId,
        connection_id: &str,
    ) -> Result<Vec<GithubRepo>> {
        let body = self
            .authorized_json(
                organization_id,
                connection_id,
                "GET",
                "https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator",
                None,
            )
            .await?;
        parse_github_repo_list(&body)
    }

    /// POST <https://api.github.com/user/repos> — **private by default**.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid name or failed authorized upstream request.
    pub async fn create_github_repo(
        &self,
        organization_id: &OrganizationId,
        connection_id: &str,
        name: &str,
        private: bool,
        description: Option<&str>,
    ) -> Result<GithubRepo> {
        let name = name.trim();
        if name.is_empty()
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
            || name.len() > 100
        {
            return Err(BrokerError::Invalid(
                "repository name must be 1–100 chars of [A-Za-z0-9._-]".into(),
            ));
        }
        let mut payload = json!({
            "name": name,
            "private": private,
            "auto_init": true,
        });
        if let Some(description) = description.map(str::trim).filter(|s| !s.is_empty()) {
            payload["description"] = json!(description);
        }
        let body = self
            .authorized_json(
                organization_id,
                connection_id,
                "POST",
                "https://api.github.com/user/repos",
                Some(payload),
            )
            .await
            .map_err(map_github_repo_create_error)?;
        parse_github_repo(&body)
    }

    /// Perform an egress-constrained HTTP call with the connection's sealed
    /// bearer token. Response JSON is returned to the caller; tokens are not.
    ///
    /// # Errors
    ///
    /// Returns an error when connection state, egress, credential opening, or
    /// the upstream request fails.
    pub async fn authorized_json(
        &self,
        organization_id: &OrganizationId,
        connection_id: &str,
        method: &str,
        url: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        let row = self.row_in_org(organization_id, connection_id).await?;
        if row.status == ConnectionStatus::Revoked {
            return Err(BrokerError::Invalid("connection is revoked".into()));
        }
        if row.status != ConnectionStatus::Active {
            return Err(BrokerError::NeedsReauth(format!(
                "connection status is {}",
                row.status.as_str()
            )));
        }
        row.egress
            .allows_url(url)
            .map_err(|e| BrokerError::Invalid(e.to_string()))?;

        // Resolve and pin the approved authority before the credential is
        // opened. The resulting client uses only those addresses and bypasses
        // process proxies, so neither DNS rebinding nor a proxy can redirect
        // the credentialed connection.
        let client = credentialed_client(url, Duration::from_secs(20)).await?;

        let key = *self.sealing_key()?;
        let credential = store::get_credential(&self.pool, &row.id)
            .await?
            .ok_or_else(|| BrokerError::NeedsReauth("connection has no credential".into()))?;
        let tokens = Self::open_tokens(&key, &row, &credential)?;
        if tokens.access_token.is_empty() {
            return Err(BrokerError::NeedsReauth("access token missing".into()));
        }
        let provider = self
            .resolve_provider(&row.organization_id, &row.provider_id)
            .await?;

        let response = Self::http_authorized(
            &client,
            &provider.id,
            &provider.auth,
            &tokens,
            method,
            url,
            body,
        )
        .await
        .map_err(BrokerError::ExchangeFailed)?;

        // Never echo Authorization headers or token fields from upstream.
        Ok(response)
    }

    /// POST raw bytes to a provider with the connection's credential injected.
    ///
    /// The sibling of [`Self::authorized_json`] for the one case where the body
    /// is ciphertext rather than JSON: attachment replication (ADR 0054). The
    /// same status and egress-allowlist checks apply, because the caller
    /// supplies the URL and must not be able to aim a credentialed request at
    /// an origin the connection never authorized.
    ///
    /// Three things are deliberate. Redirects are not followed — a redirect
    /// would replay the bearer token at an unapproved origin. Error bodies are
    /// never read or returned because a hostile provider can reflect the
    /// injected credential in one. And no part of the credential is ever
    /// returned or logged: on failure the caller learns only the status.
    ///
    /// # Errors
    ///
    /// Returns an error when the connection is unavailable, inactive, or
    /// unauthorized for the URL, request headers are unsafe, credentials
    /// cannot be opened, or the provider request fails.
    pub async fn authorized_bytes(
        &self,
        organization_id: &OrganizationId,
        connection_id: &str,
        url: &str,
        extra_headers: &[(String, String)],
        body: Vec<u8>,
    ) -> Result<()> {
        let row = self.row_in_org(organization_id, connection_id).await?;
        if row.status == ConnectionStatus::Revoked {
            return Err(BrokerError::Invalid("connection is revoked".into()));
        }
        if row.status != ConnectionStatus::Active {
            return Err(BrokerError::NeedsReauth(format!(
                "connection status is {}",
                row.status.as_str()
            )));
        }
        row.egress
            .allows_url(url)
            .map_err(|e| BrokerError::Invalid(e.to_string()))?;

        for (name, _) in extra_headers {
            if RESERVED_HEADERS
                .iter()
                .any(|reserved| name.eq_ignore_ascii_case(reserved))
            {
                return Err(BrokerError::Invalid(format!(
                    "caller may not set the {name} header on a credentialed upload"
                )));
            }
        }
        let client = credentialed_client(url, Duration::from_secs(60)).await?;

        let key = *self.sealing_key()?;
        let credential = store::get_credential(&self.pool, &row.id)
            .await?
            .ok_or_else(|| BrokerError::NeedsReauth("connection has no credential".into()))?;
        let tokens = Self::open_tokens(&key, &row, &credential)?;
        if tokens.access_token.is_empty() {
            return Err(BrokerError::NeedsReauth("access token missing".into()));
        }

        let mut req = client
            .post(url)
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .header("Content-Type", "application/octet-stream")
            .header("User-Agent", "OpenSesame-Host/0.1");
        for (name, value) in extra_headers {
            req = req.header(name.as_str(), value.as_str());
        }

        let response = req
            .body(body)
            .send()
            .await
            .map_err(|e| BrokerError::ExchangeFailed(e.without_url().to_string()))?;
        let status = response.status();
        if status.is_redirection() {
            // Following this would hand the bearer token to wherever the
            // provider points, which the allowlist never vetted.
            return Err(BrokerError::ExchangeFailed(format!(
                "upstream {status}: refusing to follow a redirect on a credentialed upload"
            )));
        }
        if !status.is_success() {
            return Err(BrokerError::ExchangeFailed(format!("upstream {status}")));
        }
        Ok(())
    }

    async fn http_authorized(
        client: &reqwest::Client,
        provider_id: &str,
        auth: &AuthMethod,
        tokens: &TokenSet,
        method: &str,
        url: &str,
        body: Option<Value>,
    ) -> std::result::Result<Value, String> {
        let parsed_method = method
            .parse::<reqwest::Method>()
            .map_err(|_| format!("unsupported method {method}"))?;
        let mut request = client
            .request(parsed_method, url)
            .header("Accept", "application/json")
            .header("User-Agent", "OpenSesame-Host/0.1");
        let (credential_name, credential_value) =
            credential_header(auth, tokens).map_err(|error| error.to_string())?;
        request = request.header(credential_name, credential_value);
        if provider_id == "github" {
            request = request
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28");
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let mut response = request
            .send()
            .await
            .map_err(|_| "upstream request failed".to_string())?;
        let status = response.status();
        let bytes = read_bounded_body(&mut response, MAX_JSON_RESPONSE_BYTES)
            .await
            .map_err(|error| match error {
                ResponseBodyError::TooLarge { .. } => {
                    "upstream response exceeds the 1 MiB limit".to_string()
                }
                ResponseBodyError::Read => "could not read upstream response".to_string(),
            })?;
        // Treat the response body as hostile at the one sink that can return
        // it. The shared scrub covers raw, partially/mixed percent, JSON and
        // HTML encodings plus standard/URL-safe base64 at every alignment.
        let (safe_bytes, credential_reflected) =
            scrub_credential_reflection(bytes, &tokens.access_token);
        let text = String::from_utf8(safe_bytes.to_vec())
            .map_err(|_| "upstream response was not valid UTF-8".to_string())?;
        if !(200..300).contains(&status.as_u16()) {
            let snippet: String = text.chars().take(MAX_ERROR_SNIPPET).collect();
            return Err(format!("upstream {status}: {snippet}"));
        }
        if credential_reflected {
            return Err("upstream response contained the injected credential".into());
        }
        if text.trim().is_empty() {
            return Ok(json!({}));
        }
        serde_json::from_str(&text).map_err(|_| "upstream response was not valid JSON".to_string())
    }
}

#[cfg(test)]
mod tests {
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
            "upstream 403 Forbidden: {\"message\":\"Resource not accessible by integration\"}"
                .into(),
        ));
        assert_eq!(mapped.code(), "invalid_request");
        assert!(mapped.hint().contains("Install the tenant GitHub App"));
        assert!(mapped.hint().contains("Re-authorize"));
    }
}

#[cfg(test)]
mod reserved_header_tests {
    use super::RESERVED_HEADERS;

    #[test]
    fn reserved_headers_cover_what_the_broker_owns() {
        // The credential header above all: a caller adding its own would leave
        // the provider to choose between two Authorization values.
        for owned in ["authorization", "content-type", "content-length", "host"] {
            assert!(
                RESERVED_HEADERS.contains(&owned),
                "{owned} is set by the broker and must not be caller-supplied"
            );
        }
        // Matching is case-insensitive at the call site, so the table itself
        // must stay lowercase for that comparison to mean anything.
        for name in RESERVED_HEADERS {
            assert_eq!(*name, name.to_ascii_lowercase());
        }
        // The one header the only caller legitimately passes is not reserved.
        assert!(!RESERVED_HEADERS
            .iter()
            .any(|r| r.eq_ignore_ascii_case("Dropbox-API-Arg")));
    }
}
