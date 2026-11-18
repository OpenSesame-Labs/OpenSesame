//! Credentialed provider HTTP: pinned destinations and bounded, opaque errors.

use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use serde_json::{json, Value};
use url::{Host, Url};

use super::{credential_header, require_secure_egress_url};
use crate::catalog::AuthMethod;
use crate::custom_egress::CustomEgressPolicy;
use crate::error::{BrokerError, Result};
use crate::token::TokenSet;
use crate::ConnectionBroker;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_JSON_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_GITHUB_ERROR_BYTES: usize = 16 * 1024;
const GITHUB_ERROR_TIMEOUT: Duration = Duration::from_secs(2);
const GITHUB_INTEGRATION_DENIED: &str = "Resource not accessible by integration";

fn is_mock_loopback(url: &Url) -> bool {
    url.scheme() == "http"
        && match url.host() {
            Some(Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
            Some(Host::Ipv4(ip)) => ip == Ipv4Addr::LOCALHOST,
            Some(Host::Ipv6(ip)) => ip == Ipv6Addr::LOCALHOST,
            None => false,
        }
}

fn mock_loopback_client(url: &Url) -> Result<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none());
    if let Some(Host::Domain(host)) = url.host() {
        let port = url
            .port_or_known_default()
            .ok_or_else(|| BrokerError::Invalid("invalid mock provider port".into()))?;
        let addrs = [
            SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
            SocketAddr::from((Ipv6Addr::LOCALHOST, port)),
        ];
        builder = builder.resolve_to_addrs(host, &addrs);
    }
    builder
        .build()
        .map_err(|_| BrokerError::Invalid("could not build mock provider transport".into()))
}

async fn read_limited(
    response: &mut reqwest::Response,
    limit: usize,
) -> std::result::Result<Vec<u8>, &'static str> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err("upstream response exceeds the size limit");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "upstream response could not be read")?
    {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err("upstream response exceeds the size limit");
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// Recognize one fixed GitHub diagnostic without returning any upstream text.
async fn github_integration_denied(response: &mut reqwest::Response) -> bool {
    let Ok(Ok(bytes)) = tokio::time::timeout(
        GITHUB_ERROR_TIMEOUT,
        read_limited(response, MAX_GITHUB_ERROR_BYTES),
    )
    .await
    else {
        return false;
    };
    serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .is_some_and(|message| message == GITHUB_INTEGRATION_DENIED)
}

fn contains_credential(value: &Value, credential: &str) -> bool {
    match value {
        Value::String(text) => text.contains(credential),
        Value::Array(items) => items
            .iter()
            .any(|item| contains_credential(item, credential)),
        Value::Object(items) => items
            .iter()
            .any(|(key, item)| key.contains(credential) || contains_credential(item, credential)),
        _ => false,
    }
}

async fn send_credentialed_json(
    client: &reqwest::Client,
    provider_id: &str,
    auth: &AuthMethod,
    tokens: &TokenSet,
    method: reqwest::Method,
    url: &str,
    body: Option<Value>,
) -> std::result::Result<Value, String> {
    let mut request = client
        .request(method, url)
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
    if !status.is_success() {
        if provider_id == "github"
            && status == reqwest::StatusCode::FORBIDDEN
            && github_integration_denied(&mut response).await
        {
            return Err(format!("upstream {status}: {GITHUB_INTEGRATION_DENIED}"));
        }
        return Err(format!("upstream {status}"));
    }
    let bytes = read_limited(&mut response, MAX_JSON_RESPONSE_BYTES)
        .await
        .map_err(str::to_owned)?;
    let text =
        String::from_utf8(bytes).map_err(|_| "upstream response was not UTF-8".to_string())?;
    if text.contains(&tokens.access_token) {
        return Err("upstream response contained the injected credential".into());
    }
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    let value: Value = serde_json::from_str(&text)
        .map_err(|_| "upstream response was not valid JSON".to_string())?;
    // Raw JSON can spell a credential with escapes. Inspect decoded keys
    // and values as well as the raw text before returning the response.
    if contains_credential(&value, &tokens.access_token) {
        return Err("upstream response contained the injected credential".into());
    }
    Ok(value)
}

impl ConnectionBroker {
    /// Build a fresh DNS-pinned client for this destination. Only a custom
    /// provider may use the operator's private-origin exceptions. The bundled
    /// mock alone may use literal/localhost loopback HTTP.
    pub(crate) async fn credentialed_egress_client(
        &self,
        provider_id: &str,
        raw: &str,
    ) -> Result<reqwest::Client> {
        require_secure_egress_url(raw)?;
        let url =
            Url::parse(raw).map_err(|_| BrokerError::Invalid("malformed provider URL".into()))?;
        if !url.username().is_empty() || url.password().is_some() {
            return Err(BrokerError::Invalid(
                "provider URL must not carry credentials".into(),
            ));
        }
        if provider_id == "mock" && is_mock_loopback(&url) {
            return mock_loopback_client(&url);
        }
        if provider_id.starts_with(crate::CUSTOM_PROVIDER_PREFIX) {
            self.config
                .custom_egress()
                .client(&url, REQUEST_TIMEOUT)
                .await
        } else {
            CustomEgressPolicy::default()
                .client(&url, REQUEST_TIMEOUT)
                .await
        }
    }

    pub(super) async fn http_authorized(
        &self,
        provider_id: &str,
        auth: &AuthMethod,
        tokens: &TokenSet,
        method: &str,
        url: &str,
        body: Option<Value>,
    ) -> std::result::Result<Value, String> {
        let parsed_method = method
            .parse::<reqwest::Method>()
            .map_err(|_| "unsupported method".to_string())?;
        let client = self
            .credentialed_egress_client(provider_id, url)
            .await
            .map_err(|error| error.to_string())?;
        send_credentialed_json(&client, provider_id, auth, tokens, parsed_method, url, body).await
    }
}

#[cfg(test)]
#[path = "egress_http_tests.rs"]
mod tests;
