//! Digest-addressed OCI component retrieval (ADR 0065 §8).
//!
//! The operator pins component bytes, not a registry's response. Registry and
//! token requests are separately fenced and never follow redirects. A token
//! realm on another origin needs explicit operator authorization.

use std::{collections::HashSet, time::Duration};

use anyhow::Context;
use url::Url;

/// Maximum accepted component size.
pub const MAX_COMPONENT_BYTES: usize = 64 * 1024 * 1024;
const MAX_TOKEN_BYTES: usize = 64 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const RESOLUTION_TIMEOUT: Duration = Duration::from_secs(5);

pub struct OciRef {
    pub registry: String,
    pub repository: String,
    pub digest: String,
}

/// Parse `registry/repository@sha256:<hex>` before constructing any request.
pub fn parse_oci_ref(reference: &str) -> anyhow::Result<OciRef> {
    let (name, digest) = reference
        .rsplit_once('@')
        .context("OCI reference lacks a digest")?;
    let hex = digest
        .strip_prefix("sha256:")
        .context("OCI digest must be sha256:<hex>")?;
    anyhow::ensure!(
        hex.len() == 64
            && hex
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
        "OCI digest must be 64 lowercase hex characters"
    );
    let (registry, repository) = name
        .split_once('/')
        .context("OCI reference must be registry/repository")?;
    // A registry is an authority, never userinfo, a path, or an alternate URL
    // spelling. Parse again with the same URL parser used by reqwest.
    anyhow::ensure!(
        registry.contains('.')
            && registry
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b':')),
        "OCI registry must be a hostname and optional port"
    );
    let base = crate::security::endpoint_fence::parse_deliverable(&format!("https://{registry}/"))
        .map_err(|_| anyhow::anyhow!("OCI registry is not a permitted HTTPS authority"))?;
    anyhow::ensure!(
        base.path() == "/" && base.query().is_none() && base.fragment().is_none(),
        "invalid OCI registry authority"
    );
    anyhow::ensure!(
        repository
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
            && repository.bytes().all(|c| c.is_ascii_lowercase()
                || c.is_ascii_digit()
                || matches!(c, b'/' | b'-' | b'_' | b'.')),
        "OCI repository has invalid characters"
    );
    Ok(OciRef {
        registry: registry.to_owned(),
        repository: repository.to_owned(),
        digest: digest.to_owned(),
    })
}

/// Parse operator-authorized extra token origins. A registry's challenge never
/// adds its own authorization.
pub fn parse_token_origins(raw: &str) -> anyhow::Result<Vec<Url>> {
    raw.split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            let url = crate::security::endpoint_fence::parse_deliverable(value)
                .map_err(|_| anyhow::anyhow!("invalid OCI token origin"))?;
            anyhow::ensure!(
                url.path() == "/" && url.query().is_none() && url.fragment().is_none(),
                "OCI token origin must not contain a path, query, or fragment"
            );
            Ok(url)
        })
        .collect()
}

/// Fetch a previously consented component; no network request occurs for an
/// unpinned digest. The content is checked again before it can be loaded.
pub async fn fetch_component(
    reference: &str,
    trusted: &HashSet<String>,
    token_origins: &[Url],
) -> anyhow::Result<Vec<u8>> {
    let parsed = parse_oci_ref(reference)?;
    anyhow::ensure!(
        trusted.contains(&parsed.digest),
        "OCI component digest is not operator-pinned"
    );
    let base =
        Url::parse(&format!("https://{}/", parsed.registry)).context("invalid OCI registry")?;
    fetch_blob_from_base(
        &Transport::production(),
        &base,
        &parsed.repository,
        &parsed.digest,
        token_origins,
    )
    .await
}

struct Transport {
    #[cfg(test)]
    test_client: Option<reqwest::Client>,
}

impl Transport {
    fn production() -> Self {
        Self {
            #[cfg(test)]
            test_client: None,
        }
    }

    #[cfg(test)]
    fn testing(client: reqwest::Client) -> Self {
        Self {
            test_client: Some(client),
        }
    }

    async fn get(&self, url: &Url, bearer: Option<&str>) -> anyhow::Result<reqwest::Response> {
        #[cfg(test)]
        if let Some(client) = &self.test_client {
            return send(client, url, bearer).await;
        }
        let url = crate::security::endpoint_fence::parse_deliverable(url.as_str())
            .map_err(|_| anyhow::anyhow!("OCI destination is not permitted"))?;
        let client = tokio::time::timeout(
            RESOLUTION_TIMEOUT,
            crate::security::endpoint_fence::pinned_client(&url, REQUEST_TIMEOUT),
        )
        .await
        .map_err(|_| anyhow::anyhow!("OCI destination resolution timed out"))?
        .map_err(|_| anyhow::anyhow!("OCI destination resolution refused"))?;
        send(&client, &url, bearer).await
    }
}

async fn send(
    client: &reqwest::Client,
    url: &Url,
    bearer: Option<&str>,
) -> anyhow::Result<reqwest::Response> {
    let mut request = client.get(url.clone());
    if let Some(token) = bearer {
        request = request.bearer_auth(token);
    }
    // Do not print a token realm's query string in an error.
    request
        .send()
        .await
        .map_err(|error| anyhow::anyhow!("OCI request failed: {}", error.without_url()))
}

async fn fetch_blob_from_base(
    transport: &Transport,
    base: &Url,
    repository: &str,
    digest: &str,
    token_origins: &[Url],
) -> anyhow::Result<Vec<u8>> {
    let url = base
        .join(&format!("v2/{repository}/blobs/{digest}"))
        .context("invalid OCI blob URL")?;
    let mut response = transport.get(&url, None).await?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        let challenge = response
            .headers()
            .get(reqwest::header::WWW_AUTHENTICATE)
            .and_then(|v| v.to_str().ok())
            .context("registry sent 401 without a WWW-Authenticate challenge")?;
        let token = anonymous_token(transport, base, challenge, token_origins).await?;
        response = transport.get(&url, Some(&token)).await?;
    }
    anyhow::ensure!(
        response.status().is_success(),
        "registry returned {} for component",
        response.status()
    );
    let bytes = read_bounded(response, MAX_COMPONENT_BYTES, "component blob").await?;
    let actual = format!(
        "sha256:{}",
        hex::encode(<sha2::Sha256 as sha2::Digest>::digest(&bytes))
    );
    anyhow::ensure!(
        actual == digest,
        "registry blob digest {actual} does not match pinned {digest} — refusing"
    );
    Ok(bytes)
}

async fn read_bounded(
    mut response: reqwest::Response,
    limit: usize,
    what: &'static str,
) -> anyhow::Result<Vec<u8>> {
    if let Some(len) = response.content_length() {
        anyhow::ensure!(len <= limit as u64, "{what} exceeds {limit} bytes");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| anyhow::anyhow!("read OCI response: {}", error.without_url()))?
    {
        anyhow::ensure!(
            chunk.len() <= limit.saturating_sub(bytes.len()),
            "{what} exceeds {limit} bytes"
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn anonymous_token(
    transport: &Transport,
    registry: &Url,
    challenge: &str,
    allowed: &[Url],
) -> anyhow::Result<String> {
    let fields = parse_bearer_challenge(challenge)
        .context("registry challenge is not a Bearer challenge")?;
    let raw_realm = fields
        .iter()
        .find(|(k, _)| k == "realm")
        .map(|(_, v)| v.as_str())
        .context("Bearer challenge lacks a realm")?;
    let mut realm = Url::parse(raw_realm).map_err(|_| anyhow::anyhow!("invalid token realm"))?;
    anyhow::ensure!(
        realm.username().is_empty() && realm.password().is_none() && realm.fragment().is_none(),
        "invalid token realm"
    );
    anyhow::ensure!(
        realm.origin() == registry.origin()
            || allowed
                .iter()
                .any(|origin| origin.origin() == realm.origin()),
        "token realm origin is not operator-authorized"
    );
    {
        let mut query = realm.query_pairs_mut();
        for (key, value) in &fields {
            if key == "service" || key == "scope" {
                query.append_pair(key, value);
            }
        }
    }
    let response = transport.get(&realm, None).await?;
    anyhow::ensure!(
        response.status().is_success(),
        "token endpoint returned {}",
        response.status()
    );
    let bytes = read_bounded(response, MAX_TOKEN_BYTES, "token response").await?;
    let body: serde_json::Value = serde_json::from_slice(&bytes).context("token response")?;
    let token = body
        .get("token")
        .or_else(|| body.get("access_token"))
        .and_then(serde_json::Value::as_str)
        .context("token response carries no token")?;
    Ok(token.to_owned())
}

/// Minimal parser for `Bearer k="v",k2="v2"`; malformed values fail closed.
fn parse_bearer_challenge(challenge: &str) -> Option<Vec<(String, String)>> {
    let rest = challenge.trim().strip_prefix("Bearer ")?;
    let mut fields = Vec::new();
    for part in rest.split(',') {
        let (key, value) = part.trim().split_once('=')?;
        let value = value.strip_prefix('"')?.strip_suffix('"')?;
        if value.contains('"') || value.contains('\\') {
            return None;
        }
        fields.push((key.trim().to_owned(), value.to_owned()));
    }
    Some(fields)
}

#[cfg(test)]
#[path = "oci_component_tests.rs"]
mod tests;
