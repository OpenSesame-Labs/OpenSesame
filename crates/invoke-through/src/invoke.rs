//! The invoke-through executor (ADR 0048 D6/D7, I8).
//!
//! Call sequence: [`Invoker::preflight`] validates the request against the
//! egress allowlist **before any credential is touched and before any
//! connection is attempted**; the caller then acquires a token (on a blocking
//! thread — source tools are child processes) and hands it to
//! [`Invoker::execute`]. The token enters exactly one
//! `Authorization: Bearer` header, marked sensitive, and is dropped with the
//! request. Redirects are never followed: hyper follows none by default and a
//! 3xx is returned to the caller like any other status — a credential must
//! never be chased onto a host the allowlist did not name.
//!
//! The wire client is hyper over rustls with **webpki roots only** (no native
//! cert store, no reqwest, no cookie store — the ADR 0048 D5 budget), or the
//! scoped profile the authority plane injects through [`Invoker::with_tls`].

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::header::HeaderValue;
use secrecy::{ExposeSecret, SecretString};
use serde::Serialize;
use zeroize::Zeroizing;

use crate::egress::{AuthStyle, EgressRule, EGRESS_RULES};
use crate::error::InvokeError;
use crate::fence::{EgressFence, PreparedRequest};
use crate::scrub::{scrub_needles, scrub_needles_str, Needles};
use crate::source::TokenSource;
use crate::tls::{build_client, build_pinned_client, HttpsClient, TlsClientSpec};

#[cfg(test)]
#[path = "invoke_stub.rs"]
pub(crate) mod stub;

#[path = "invoke_dispatch.rs"]
mod dispatch;

/// Outbound body cap: generous for an API payload, useless for exfiltration.
pub const DEFAULT_REQUEST_BODY_CAP: usize = 256 * 1024;
/// Inbound body cap (ADR 0048 D7: the upstream response only, capped).
pub const DEFAULT_RESPONSE_BODY_CAP: usize = 1024 * 1024;
/// Whole-call timeout, connect through last body byte.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);

/// Response headers passed back to the caller. Everything else upstream sent
/// is dropped here — `set-cookie` above all.
const RESPONSE_HEADER_ALLOWLIST: &[&str] = &[
    "content-type",
    "etag",
    "cache-control",
    "retry-after",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "x-github-request-id",
];

const DEFAULT_USER_AGENT: &str = concat!("opensesame-invoke-through/", env!("CARGO_PKG_VERSION"));

/// One validated invoke-through call.
pub struct InvokeRequest {
    pub provider_id: String,
    pub method: String,
    pub url: String,
    /// Name/value pairs; each name must pass
    /// [`forwardable_request_header`](crate::forwardable_request_header) for
    /// this provider.
    pub headers: Vec<(String, String)>,
    pub body: Option<Bytes>,
    /// RFC 8693 placeholders carried into the receipt (ADR 0049 §5). The
    /// daemon fills them; this crate only echoes them through.
    pub subject: Option<String>,
    pub actor: Option<String>,
}

/// The upstream response after bounded direct-reflection scrubbing.
/// It can still contain transformed credentials and is not safe to disclose
/// or log without an additional output policy.
pub struct InvokeResponse {
    pub status: u16,
    /// Allowlisted response headers only.
    pub headers: Vec<(String, String)>,
    pub body: Bytes,
    pub receipt: ReceiptMeta,
}

impl std::fmt::Debug for InvokeResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InvokeResponse")
            .field("status", &self.status)
            .finish_non_exhaustive()
    }
}

/// Structured receipt metadata for one brokered call (ADR 0049 §5).
///
/// `path` is the URL path **only** — query strings may carry secrets
/// (presigned URLs, `?access_token=`) and are never recorded. Serialize this
/// with the same care as other caller-supplied request metadata.
#[derive(Debug, Clone, Serialize)]
pub struct ReceiptMeta {
    pub provider_id: String,
    pub scheme: String,
    pub host: String,
    pub path: String,
    pub status: u16,
    pub latency_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor: Option<String>,
    /// The upstream echoed the credential and the broker scrubbed it. Never
    /// expected from a well-behaved API, so it is worth a look when set.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub credential_reflected: bool,
}

/// The broker. Cheap to build; the daemon holds one in shared state.
pub struct Invoker {
    client: HttpsClient,
    /// Every pre-connect check, separable so a caller can run it before any
    /// identity is resolved or credential opened.
    fence: EgressFence,
    /// The authority and complete socket set approved before this client was
    /// built. Hyper's resolver API is handed only a host name and may replace
    /// the returned socket ports with the URI's port, so the request must
    /// agree with every pinned socket before a credential is acquired or
    /// materialized.
    pinned: Option<(String, Vec<SocketAddr>)>,
    response_body_cap: usize,
    timeout: Duration,
}

impl Default for Invoker {
    fn default() -> Self {
        Self::new()
    }
}

impl Invoker {
    /// Production broker: the static catalog-derived allowlist, https only.
    #[must_use]
    pub fn new() -> Self {
        Self::with_rules(EGRESS_RULES.to_vec())
    }

    /// Broker over an explicit rule set. Still https only — see
    /// [`Invoker::allow_http_for_tests`].
    #[must_use]
    pub fn with_rules(rules: Vec<EgressRule>) -> Self {
        Self::from_client(build_client(None), rules, None)
    }

    /// Broker over WebPKI and an address set an egress preflight already
    /// approved. The URI hostname remains rustls' verification name; the
    /// pinned resolver only prevents a second DNS lookup from rebinding the
    /// credentialed dial to another address.
    #[must_use]
    pub fn with_pinned_webpki(
        rules: Vec<EgressRule>,
        authority_host: &str,
        addresses: &[SocketAddr],
    ) -> Self {
        Self::from_client(
            build_pinned_client(authority_host, addresses),
            rules,
            Some((authority_host.to_ascii_lowercase(), addresses.to_vec())),
        )
    }

    /// Broker over an explicit rule set and an injected, already-validated
    /// TLS profile (server trust, expected server name, optional client
    /// identity, pinned addresses). Https only: the injected config is the
    /// only trust this client has. The egress allowlist, no-redirect, header
    /// and body fences are exactly those of [`Invoker::with_rules`].
    #[must_use]
    pub fn with_tls(rules: Vec<EgressRule>, tls: &TlsClientSpec) -> Self {
        Self::from_client(build_client(Some(tls)), rules, tls.pinned.clone())
    }

    fn from_client(
        client: HttpsClient,
        rules: Vec<EgressRule>,
        pinned: Option<(String, Vec<SocketAddr>)>,
    ) -> Self {
        Self {
            client,
            fence: EgressFence::new(rules, DEFAULT_REQUEST_BODY_CAP),
            pinned: pinned.map(|(host, addresses)| (host.to_ascii_lowercase(), addresses)),
            response_body_cap: DEFAULT_RESPONSE_BODY_CAP,
            timeout: DEFAULT_TIMEOUT,
        }
    }

    /// The pre-connect fence alone, for a caller that must clear a request
    /// before resolving an identity or opening a credential.
    #[must_use]
    pub fn fence(&self) -> &EgressFence {
        &self.fence
    }

    /// Test mode: permit plain HTTP **to loopback hosts only**, for
    /// in-process stubs, and a non-default port on either scheme (a test TLS
    /// listener binds port 0). The egress allowlist still applies; this
    /// relaxes the scheme check alone, and only for 127.0.0.1 / `::1` /
    /// localhost.
    #[must_use]
    pub fn allow_http_for_tests(mut self) -> Self {
        self.fence.allow_http_for_tests = true;
        self
    }

    /// Override the body caps (tests exercise them with small values).
    #[must_use]
    pub fn with_caps(mut self, request_body_cap: usize, response_body_cap: usize) -> Self {
        self.fence.request_body_cap = request_body_cap;
        self.response_body_cap = response_body_cap;
        self
    }

    #[must_use]
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Validate every fence that must hold before a credential is touched or
    /// a socket is opened: provider adapter, egress allowlist (exact host
    /// match), https, method, header allowlist, body cap.
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn preflight(&self, req: InvokeRequest) -> Result<PreparedRequest, InvokeError> {
        let prepared = self.fence.preflight(req)?;
        self.validate_pinned_destination(&prepared)?;
        Ok(prepared)
    }

    /// Pin the complete socket identity, not just its IP address. Hyper's
    /// connector applies the URI port after resolution, so a resolver that
    /// returns `127.0.0.1:4443` for an implicit `:443` request would otherwise
    /// dial the approved IP on an unapproved port. Requiring every returned
    /// socket to agree also prevents a mixed-port pin set from being widened
    /// by that rewrite.
    pub(crate) fn validate_pinned_destination(
        &self,
        prepared: &PreparedRequest,
    ) -> Result<(), InvokeError> {
        let Some((host, addresses)) = &self.pinned else {
            return Ok(());
        };
        let requested_port = prepared.port().unwrap_or_else(|| {
            if prepared.scheme.eq_ignore_ascii_case("https") {
                443
            } else {
                80
            }
        });
        if prepared.host != *host
            || addresses.is_empty()
            || addresses
                .iter()
                .any(|address| address.port() != requested_port)
        {
            return Err(InvokeError::EgressDenied {
                provider: prepared.provider_id.clone(),
                host: prepared.host.clone(),
            });
        }
        Ok(())
    }

    /// The single socket port approved for `host`, when every pin agrees.
    /// A mixed-port pin set approves nothing.
    #[must_use]
    pub fn pinned_port(&self, host: &str) -> Option<u16> {
        let (pinned_host, addresses) = self.pinned.as_ref()?;
        if !pinned_host.eq_ignore_ascii_case(host) || addresses.is_empty() {
            return None;
        }
        let port = addresses[0].port();
        addresses
            .iter()
            .all(|address| address.port() == port)
            .then_some(port)
    }

    /// Execute a preflighted request with an acquired credential. The token
    /// is placed into exactly one sensitive header and dropped with the
    /// request; the response is the upstream's status, allowlisted headers,
    /// and capped body — never a redirect chase, never a cookie.
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub async fn execute(
        &self,
        token: &SecretString,
        prepared: PreparedRequest,
    ) -> Result<InvokeResponse, InvokeError> {
        // Callers may use `fence()` directly so they can clear a request
        // before loading credentials. Preserve that API, but repeat the
        // client-specific pin check here before the token is exposed.
        self.validate_pinned_destination(&prepared)?;
        if prepared.auth != AuthStyle::Bearer {
            return Err(InvokeError::UnsupportedProvider(prepared.provider_id));
        }
        let started = Instant::now();
        let mut builder = Self::request_builder(&prepared);
        // The one place the token is materialized into the request. The
        // formatted `Bearer …` string is zeroized immediately after the
        // header value is built; the header itself is marked sensitive so
        // Debug representations redact it.
        let mut authorization =
            HeaderValue::from_str(&Zeroizing::new(format!("Bearer {}", token.expose_secret())))
                .map_err(|_| InvokeError::MalformedToken)?;
        authorization.set_sensitive(true);
        builder = builder.header(hyper::header::AUTHORIZATION, authorization);
        let request = builder
            .body(Full::new(prepared.body.clone()))
            .map_err(|_| InvokeError::InvalidUrl)?;
        let needles = [Needles::new(token.expose_secret())];
        self.dispatch(request, &needles, prepared, started).await
    }

    /// The method, URI and caller headers of a cleared request, plus the
    /// default user agent when the caller set none.
    pub(crate) fn request_builder(prepared: &PreparedRequest) -> hyper::http::request::Builder {
        let mut builder = hyper::Request::builder()
            .method(prepared.method.clone())
            .uri(prepared.uri.clone());
        for (name, value) in &prepared.headers {
            builder = builder.header(name, value);
        }
        if !prepared
            .headers
            .iter()
            .any(|(name, _)| name.as_str() == "user-agent")
        {
            builder = builder.header("user-agent", DEFAULT_USER_AGENT);
        }
        builder
    }

    /// Preflight + acquire + execute in one step, for callers whose token
    /// source is cheap. Daemons should instead preflight, acquire on a
    /// blocking thread, then [`Invoker::execute`] — a denied request must
    /// never run the source tool.
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub async fn execute_with_source(
        &self,
        source: &dyn TokenSource,
        req: InvokeRequest,
    ) -> Result<InvokeResponse, InvokeError> {
        let prepared = self.preflight(req)?;
        let token = source.acquire()?;
        self.execute(&token, prepared).await
    }
}

/// One header value through every needle in turn.
fn scrub_all(needles: &[Needles], value: String) -> (String, bool) {
    scrub_needles_str(needles, value)
}

#[cfg(test)]
#[path = "invoke_tests.rs"]
mod tests;
