//! Credentialed JSON egress and owner connection identity checks.

use super::{
    credential_header, credentialed_egress_client, AuthMethod, BrokerError, ConnectionBroker,
    ConnectionStatus, Duration, OrganizationId, Result, TokenSet,
};
use crate::response_guard::{read_bounded_body, ResponseBodyError};
use crate::store::{self, ConnectionRow};
use opensesame_domain::Grant;
use opensesame_invoke_through::scrub_credential_reflection;
use opensesame_time::Utc;
use serde_json::{json, Value};

/// Immutable expectations from the caller's already-authorized invocation.
/// Comparing these fields with storage does not itself authorize an effect.
pub struct OwnerConnectionExpectation<'a> {
    pub organization_id: &'a OrganizationId,
    pub connection_id: &'a str,
    pub provider_id: &'a str,
    pub owner_subject: &'a str,
    pub grant: &'a Grant,
}

/// Characters of an upstream error body kept for diagnostics.
const MAX_ERROR_SNIPPET: usize = 512;
const MAX_JSON_RESPONSE_BYTES: usize = 1024 * 1024;

/// Upstream HTTP status and metadata with scrubbed JSON for owner egress.
pub struct OwnerEgressHttpResult {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub json: Value,
}

/// Drop credential-bearing response headers. `set-cookie`,
/// `proxy-authenticate`, `proxy-authorization`, `cookie`, `authorization`,
/// and `www-authenticate` never leave this sink, whatever they carry — the
/// static drop does not wait for a reflection match. Any other header that
/// echoes the injected access token, in a form the reflection scrub
/// recognizes, is omitted rather than returned redacted.
fn retained_response_headers(
    headers: &reqwest::header::HeaderMap,
    access_token: &str,
) -> Vec<(String, String)> {
    headers
        .iter()
        .filter_map(|(name, value)| {
            let lower = name.as_str().to_ascii_lowercase();
            if matches!(
                lower.as_str(),
                "set-cookie"
                    | "authorization"
                    | "www-authenticate"
                    | "proxy-authenticate"
                    | "proxy-authorization"
                    | "cookie"
            ) {
                return None;
            }
            let value = value.to_str().ok()?;
            let (scrubbed, reflected) = scrub_credential_reflection(
                bytes::Bytes::copy_from_slice(value.as_bytes()),
                access_token,
            );
            if reflected {
                return None;
            }
            let safe = String::from_utf8(scrubbed.to_vec()).ok()?;
            Some((name.to_string(), safe))
        })
        .collect()
}

impl ConnectionBroker {
    /// Perform an egress-constrained HTTP call with the connection's sealed
    /// bearer token. Response JSON is returned to the caller; tokens are not.
    ///
    /// # Errors
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
        self.authorized_json_for_row(row, method, url, body).await
    }

    /// Check the expected provider and owner against the same stored row used
    /// for credentialed egress. The caller must separately authorize the request.
    ///
    /// # Errors
    /// Returns an error when identity, connection state, egress, credential
    /// opening, or the upstream request fails.
    pub async fn authorized_json_for_owner(
        &self,
        expected: OwnerConnectionExpectation<'_>,
        method: &str,
        url: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        let row = self
            .row_in_org(expected.organization_id, expected.connection_id)
            .await?;
        let grant_connection = expected.grant.connection_id.map(|id| id.to_string());
        if expected.provider_id.is_empty()
            || expected.owner_subject.is_empty()
            || row.provider_id != expected.provider_id
            || row.owner_subject.as_deref() != Some(expected.owner_subject)
            || expected.grant.organization_id != *expected.organization_id
            || grant_connection.as_deref() != Some(expected.connection_id)
            || expected.grant.parent_grant_id.is_some()
            || expected.grant.delegation_depth != 0
            || expected.grant.assert_active(Utc::now()).is_err()
        {
            return Err(BrokerError::ConnectionNotFound);
        }
        let stored =
            crate::delegation_lineage::load_grant(&self.pool, &expected.grant.id.to_string())
                .await?;
        if stored.as_ref() != Some(expected.grant) {
            return Err(BrokerError::ConnectionNotFound);
        }
        self.authorized_json_for_row(row, method, url, body).await
    }

    /// Owner-checked egress returning preserved upstream HTTP metadata.
    ///
    /// # Errors
    /// Same as [`Self::authorized_json_for_owner`].
    pub async fn authorized_http_for_owner(
        &self,
        expected: OwnerConnectionExpectation<'_>,
        method: &str,
        url: &str,
        body: Option<Value>,
    ) -> Result<OwnerEgressHttpResult> {
        let row = self
            .row_in_org(expected.organization_id, expected.connection_id)
            .await?;
        let grant_connection = expected.grant.connection_id.map(|id| id.to_string());
        if expected.provider_id.is_empty()
            || expected.owner_subject.is_empty()
            || row.provider_id != expected.provider_id
            || row.owner_subject.as_deref() != Some(expected.owner_subject)
            || expected.grant.organization_id != *expected.organization_id
            || grant_connection.as_deref() != Some(expected.connection_id)
            || expected.grant.parent_grant_id.is_some()
            || expected.grant.delegation_depth != 0
            || expected.grant.assert_active(Utc::now()).is_err()
        {
            return Err(BrokerError::ConnectionNotFound);
        }
        let stored =
            crate::delegation_lineage::load_grant(&self.pool, &expected.grant.id.to_string())
                .await?;
        if stored.as_ref() != Some(expected.grant) {
            return Err(BrokerError::ConnectionNotFound);
        }
        self.authorized_http_for_row(row, method, url, body).await
    }

    async fn authorized_json_for_row(
        &self,
        row: ConnectionRow,
        method: &str,
        url: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        Ok(self
            .authorized_http_for_row(row, method, url, body)
            .await?
            .json)
    }

    async fn authorized_http_for_row(
        &self,
        row: ConnectionRow,
        method: &str,
        url: &str,
        body: Option<Value>,
    ) -> Result<OwnerEgressHttpResult> {
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

        let client = credentialed_egress_client(
            &self.config,
            &row.provider_id,
            url,
            Duration::from_secs(20),
        )
        .await?;
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
        Self::http_authorized(
            &client,
            &provider.id,
            &provider.auth,
            &tokens,
            method,
            url,
            body,
        )
        .await
        .map_err(BrokerError::ExchangeFailed)
    }

    async fn http_authorized(
        client: &reqwest::Client,
        provider_id: &str,
        auth: &AuthMethod,
        tokens: &TokenSet,
        method: &str,
        url: &str,
        body: Option<Value>,
    ) -> std::result::Result<OwnerEgressHttpResult, String> {
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
        let response = request
            .send()
            .await
            .map_err(|_| "upstream request failed".to_string())?;
        let status = response.status();
        let headers = retained_response_headers(response.headers(), &tokens.access_token);
        let mut response = response;
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
        // Error and success bodies share this refusal: a non-2xx response
        // echoing the credential is refused, not returned as a snippet.
        if credential_reflected {
            return Err("upstream response contained the injected credential".into());
        }
        if !(200..300).contains(&status.as_u16()) {
            let snippet: String = text.chars().take(MAX_ERROR_SNIPPET).collect();
            return Err(format!("upstream {status}: {snippet}"));
        }
        let json = if text.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(&text)
                .map_err(|_| "upstream response was not valid JSON".to_string())?
        };
        Ok(OwnerEgressHttpResult {
            status: status.as_u16(),
            headers,
            json,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::retained_response_headers;
    use reqwest::header::{HeaderMap, HeaderValue};

    #[test]
    fn reflected_credential_headers_are_dropped_and_safe_headers_remain() {
        let token = "network-token-do-not-return";
        let encoded: String = token.bytes().map(|byte| format!("%{byte:02X}")).collect();
        let mut headers = HeaderMap::new();
        headers.insert("x-request-id", HeaderValue::from_static("req-1"));
        headers.insert("x-note", HeaderValue::from_static("plain"));
        headers.insert(
            "location",
            HeaderValue::from_str(&format!("https://app.example/cb?access_token={token}")).unwrap(),
        );
        headers.insert(
            "cookie",
            HeaderValue::from_str(&format!("session={token}")).unwrap(),
        );
        headers.insert(
            "x-next",
            HeaderValue::from_str(&format!("next={encoded}")).unwrap(),
        );
        headers.insert("set-cookie", HeaderValue::from_static("sid=secret"));
        headers.insert(
            "authorization",
            HeaderValue::from_static("Bearer something-else"),
        );
        headers.insert(
            "www-authenticate",
            HeaderValue::from_static("Bearer realm=api"),
        );

        let kept = retained_response_headers(&headers, token);
        let rendered = kept
            .iter()
            .map(|(name, value)| format!("{name}:{value}"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!rendered.contains(token));
        assert!(!rendered
            .to_ascii_lowercase()
            .contains(&encoded.to_ascii_lowercase()));
        assert!(kept
            .iter()
            .any(|(name, value)| name.eq_ignore_ascii_case("x-request-id") && value == "req-1"));
        assert!(kept
            .iter()
            .any(|(name, value)| name.eq_ignore_ascii_case("x-note") && value == "plain"));
        for dropped in [
            "location",
            "cookie",
            "x-next",
            "set-cookie",
            "authorization",
            "www-authenticate",
        ] {
            assert!(
                !kept
                    .iter()
                    .any(|(name, _)| name.eq_ignore_ascii_case(dropped)),
                "{dropped} was returned"
            );
        }
    }

    #[test]
    fn credential_shaped_headers_are_dropped_even_without_reflection() {
        // The static drop list does not wait for the token to appear: a
        // proxy challenge or a benign-looking cookie is credential-shaped
        // and never leaves the sink, whatever its value.
        let token = "network-token-do-not-return";
        let mut headers = HeaderMap::new();
        headers.insert("x-request-id", HeaderValue::from_static("req-1"));
        headers.insert(
            "proxy-authenticate",
            HeaderValue::from_static("Basic realm=proxy"),
        );
        headers.insert(
            "proxy-authorization",
            HeaderValue::from_static("Bearer internal-service"),
        );
        headers.insert("cookie", HeaderValue::from_static("theme=dark"));
        let kept = retained_response_headers(&headers, token);
        assert!(kept
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("x-request-id")));
        for dropped in ["proxy-authenticate", "proxy-authorization", "cookie"] {
            assert!(
                !kept
                    .iter()
                    .any(|(name, _)| name.eq_ignore_ascii_case(dropped)),
                "{dropped} was returned"
            );
        }
    }
}
