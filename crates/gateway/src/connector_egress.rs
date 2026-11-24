//! Boot-time loading of community Wasm connectors (ADR 0065 §5) and the
//! gateway's [`HostEgress`] bridge.
//!
//! Operator contract, fail-closed at every step:
//! - `OPENSESAME_CONNECTOR_DIR` names a directory of `<id>/connector.yaml`
//!   entries, each with a sibling `component.wasm` OR a digest-addressed
//!   pull from `spec.component.oci` (a local file wins). Unset means no
//!   community connectors.
//! - `OPENSESAME_CONNECTOR_TRUSTED_DIGESTS` is a comma-separated list of
//!   `sha256:<hex>` digests. Setting the directory without pinning digests
//!   refuses boot: consent is a pinned digest, never a directory listing.
//! - `OPENSESAME_CONNECTOR_OCI_TOKEN_ORIGINS` optionally authorizes additional
//!   HTTPS origins for registry bearer-token services. Without it, a token
//!   realm must share the registry origin.
//! - Any unreadable, invalid, or unpinned entry refuses boot — a gateway
//!   never comes up "mostly" trusted.
//! - When the `wasm-connectors` feature is off, setting the directory also
//!   refuses boot rather than silently ignoring the operator's intent.

pub const ENV_CONNECTOR_DIR: &str = "OPENSESAME_CONNECTOR_DIR";
#[cfg_attr(not(feature = "wasm-connectors"), allow(dead_code))]
pub const ENV_TRUSTED_DIGESTS: &str = "OPENSESAME_CONNECTOR_TRUSTED_DIGESTS";
#[cfg_attr(not(feature = "wasm-connectors"), allow(dead_code))]
pub const ENV_TOKEN_ORIGINS: &str = "OPENSESAME_CONNECTOR_OCI_TOKEN_ORIGINS";

#[cfg(feature = "wasm-connectors")]
pub use enabled::load_wasm_connectors;

#[cfg(feature = "wasm-connectors")]
mod enabled {
    use super::{ENV_CONNECTOR_DIR, ENV_TOKEN_ORIGINS, ENV_TRUSTED_DIGESTS};
    use anyhow::Context;
    use opensesame_connection_broker::{egress::OwnerConnectionExpectation, ConnectionBroker};
    use opensesame_connector_host::manifest::ConnectorManifest;
    use opensesame_connector_host::wasm::{
        EgressRequest, EgressResponse, GuestLimits, HostEgress, WasmConnector,
    };
    use opensesame_connector_host::{HostRuntime, InvocationBinding};
    use opensesame_domain::ConnectionId;
    use opensesame_time::Utc;
    use std::sync::Arc;

    /// Bridges guest `host-http` calls onto the connection broker — the one
    /// credential-injection funnel. The guest supplies a connection ref and
    /// a fenced destination; the broker resolves and injects the credential
    /// host-side and returns only the response.
    ///
    /// `sign`/`oauth` stay refused until the catalog promotion recorded in
    /// ADR 0065 §8 defines which keys and token endpoints a community
    /// connector may exercise. Refusing here is deliberate fail-closed
    /// posture, not a stub to quietly widen later.
    struct GatewayEgress {
        broker: Arc<ConnectionBroker>,
        registered_provider: String,
        handle: tokio::runtime::Handle,
    }

    pub(super) fn accepts_binding(
        binding: &InvocationBinding,
        connection_ref: &str,
        registered_provider: &str,
    ) -> Option<ConnectionId> {
        let connection = binding.connection_id()?;
        if binding.is_delegated()
            || binding.connection_policy_id() != connection_ref
            || registered_provider != connection_ref
            || binding.grant().connection_id != Some(connection)
            || binding.grant().assert_active(Utc::now()).is_err()
        {
            return None;
        }
        Some(connection)
    }

    #[cfg(test)]
    pub(super) fn bridge_for_test(
        broker: Arc<ConnectionBroker>,
        registered_provider: &str,
    ) -> impl HostEgress {
        GatewayEgress {
            broker,
            registered_provider: registered_provider.to_owned(),
            handle: tokio::runtime::Handle::current(),
        }
    }

    impl GatewayEgress {
        fn run_egress(
            &self,
            connection_id: &str,
            binding: &InvocationBinding,
            req: &EgressRequest,
        ) -> Result<opensesame_connection_broker::OwnerEgressHttpResult, String> {
            let body = if req.body.is_empty() {
                None
            } else {
                Some(
                    serde_json::from_slice(&req.body)
                        .map_err(|_| "request body must be JSON".to_owned())?,
                )
            };
            // Per-invocation tenant. Never the process-startup demo or nil org.
            let organization = binding.organization_id();
            tokio::task::block_in_place(|| {
                self.handle.block_on(self.broker.authorized_http_for_owner(
                    OwnerConnectionExpectation {
                        organization_id: &organization,
                        connection_id,
                        provider_id: &self.registered_provider,
                        owner_subject: binding.subject(),
                        grant: binding.grant(),
                    },
                    &req.method,
                    &req.url,
                    body,
                ))
            })
            .map_err(|_| "owner egress unavailable".to_owned())
        }

        /// Headers that never cross from an upstream response into a Wasm
        /// guest. The broker's egress sink already drops these; this second
        /// drop is at the one boundary that faces guest memory, so a broker
        /// regression or a future `OwnerEgressHttpResult` producer cannot
        /// hand a credential-shaped header to untrusted code.
        fn guest_safe_headers(headers: Vec<(String, String)>) -> Vec<(String, String)> {
            headers
                .into_iter()
                .filter(|(name, _)| {
                    !matches!(
                        name.to_ascii_lowercase().as_str(),
                        "set-cookie"
                            | "authorization"
                            | "www-authenticate"
                            | "proxy-authenticate"
                            | "proxy-authorization"
                            | "cookie"
                    )
                })
                .collect()
        }
    }

    impl HostEgress for GatewayEgress {
        fn authorized_request(
            &self,
            binding: &InvocationBinding,
            connection_ref: &str,
            req: EgressRequest,
        ) -> Result<EgressResponse, String> {
            // The connector and provider share the registered manifest ID;
            // the durable connection is a separate, invocation-bound UUID.
            let connection = accepts_binding(binding, connection_ref, &self.registered_provider)
                .ok_or_else(|| "invocation binding denied".to_owned())?;
            let upstream = self.run_egress(&connection.to_string(), binding, &req)?;
            // A body that cannot be encoded is an error, not an empty body a
            // guest would read as "no result".
            let body = serde_json::to_vec(&upstream.json)
                .map_err(|_| "upstream response could not be encoded".to_owned())?;
            Ok(EgressResponse {
                status: upstream.status,
                headers: Self::guest_safe_headers(upstream.headers),
                body,
            })
        }

        fn sign(
            &self,
            _binding: &InvocationBinding,
            _purpose: &str,
            _digest: &[u8],
        ) -> Result<Vec<u8>, String> {
            Err("host-crypto.sign is not yet open to community connectors (ADR 0065 §8)".into())
        }

        fn oauth_acquire(
            &self,
            _binding: &InvocationBinding,
            _connection_ref: &str,
            _resource: Option<&str>,
            _audience: Option<&str>,
            _scopes: &[String],
        ) -> Result<u32, String> {
            Err("host-oauth.acquire is not yet open to community connectors (ADR 0065 §8)".into())
        }

        fn authenticated_request(
            &self,
            _binding: &InvocationBinding,
            _connection_ref: &str,
            _token_handle: u32,
            _req: EgressRequest,
        ) -> Result<EgressResponse, String> {
            Err(
                "host-oauth.authenticated-request is not yet open to community connectors (ADR 0065 §8)"
                    .into(),
            )
        }
    }

    /// Scan the operator's connector directory and register every entry.
    /// Every failure is a boot refusal.
    ///
    /// # Errors
    ///
    /// Returns an error on any unreadable entry, invalid manifest, unpinned
    /// or mismatched digest, or component that fails to load.
    pub async fn load_wasm_connectors(
        host: &mut HostRuntime,
        broker: &Arc<ConnectionBroker>,
    ) -> anyhow::Result<()> {
        let Ok(dir) = std::env::var(ENV_CONNECTOR_DIR) else {
            return Ok(());
        };
        let digests = std::env::var(ENV_TRUSTED_DIGESTS).unwrap_or_default();
        let pinned: Vec<String> = digests
            .split(',')
            .map(str::trim)
            .filter(|d| !d.is_empty())
            .map(str::to_owned)
            .collect();
        anyhow::ensure!(
            !pinned.is_empty(),
            "{ENV_CONNECTOR_DIR} is set but {ENV_TRUSTED_DIGESTS} pins nothing; \
             consent is a pinned digest (ADR 0065 §3)"
        );
        host.policy.trusted_digests.extend(pinned);
        let token_origins = crate::oci_component::parse_token_origins(
            &std::env::var(ENV_TOKEN_ORIGINS).unwrap_or_default(),
        )
        .with_context(|| format!("invalid {ENV_TOKEN_ORIGINS}"))?;

        let mut loaded = 0usize;
        for entry in std::fs::read_dir(&dir).with_context(|| format!("read {dir}"))? {
            let path = entry?.path();
            if !path.is_dir() {
                continue;
            }
            let manifest_path = path.join("connector.yaml");
            if !manifest_path.exists() {
                continue;
            }
            let manifest_text = std::fs::read_to_string(&manifest_path)
                .with_context(|| format!("read {}", manifest_path.display()))?;
            let manifest = ConnectorManifest::from_yaml(&manifest_text)
                .with_context(|| format!("parse {}", manifest_path.display()))?;
            let registered_provider = manifest.metadata.id.clone();
            // Organization is taken from each invocation binding. A startup
            // demo or nil organization must not be captured on the egress bridge.
            let egress: Arc<dyn HostEgress> = Arc::new(GatewayEgress {
                broker: Arc::clone(broker),
                registered_provider: registered_provider.clone(),
                handle: tokio::runtime::Handle::current(),
            });
            // A local component file wins (operator override); otherwise the
            // component is pulled from the manifest's digest-addressed OCI
            // reference — the digest check in WasmConnector::load re-verifies
            // whatever arrives either way.
            let component_path = path.join("component.wasm");
            let component_bytes = if component_path.exists() {
                std::fs::read(&component_path)
                    .with_context(|| format!("read {}", component_path.display()))?
            } else {
                crate::oci_component::fetch_component(
                    &manifest.spec.component.oci,
                    &host.policy.trusted_digests,
                    &token_origins,
                )
                .await
                .with_context(|| format!("pull component for {}", path.display()))?
            };
            let connector = WasmConnector::load(
                manifest,
                &component_bytes,
                &host.policy,
                Arc::clone(&egress),
                GuestLimits::default(),
            )
            .map_err(|e| anyhow::anyhow!("load {}: {e}", path.display()))?;

            let id = opensesame_connector_host::Connector::id(&connector).to_owned();
            anyhow::ensure!(
                id == registered_provider,
                "connector registration identity changed"
            );
            host.register_connector(Arc::new(connector))
                .map_err(|e| anyhow::anyhow!("register {id}: {e}"))?;
            host.bind_connection(id.clone(), &id)
                .map_err(|e| anyhow::anyhow!("bind connection {id}: {e}"))?;
            host.bind_provider(id.clone(), &id)
                .map_err(|e| anyhow::anyhow!("bind provider {id}: {e}"))?;
            tracing::info!(connector = %id, "wasm connector registered");
            loaded += 1;
        }
        tracing::info!(loaded, "wasm connector directory processed");
        Ok(())
    }

    #[cfg(test)]
    mod guest_boundary_tests {
        use super::GatewayEgress;

        #[test]
        fn credential_shaped_headers_never_reach_the_guest() {
            let headers = vec![
                ("X-Request-Id".to_owned(), "req-1".to_owned()),
                ("Set-Cookie".to_owned(), "sid=1".to_owned()),
                ("set-cookie".to_owned(), "sid=2".to_owned()),
                ("Authorization".to_owned(), "Bearer echoed".to_owned()),
                ("WWW-Authenticate".to_owned(), "Bearer realm=api".to_owned()),
                (
                    "Proxy-Authenticate".to_owned(),
                    "Basic realm=proxy".to_owned(),
                ),
                (
                    "Proxy-Authorization".to_owned(),
                    "Bearer internal".to_owned(),
                ),
                ("Cookie".to_owned(), "theme=dark".to_owned()),
            ];
            let kept = GatewayEgress::guest_safe_headers(headers);
            assert_eq!(kept, vec![("X-Request-Id".to_owned(), "req-1".to_owned())]);
        }
    }
}

#[cfg(all(test, feature = "wasm-connectors"))]
#[path = "connector_egress_binding_tests.rs"]
mod binding_tests;

#[cfg(all(test, feature = "wasm-connectors"))]
#[path = "connector_egress_owner_tests.rs"]
mod owner_tests;

#[cfg(all(test, feature = "wasm-connectors"))]
#[path = "connector_egress_owner_wasm_tests.rs"]
mod owner_wasm_tests;

/// Feature-off build: the operator asking for connectors is a hard error —
/// never a silent no-op.
///
/// # Errors
///
/// Returns an error when `OPENSESAME_CONNECTOR_DIR` is set.
#[cfg(not(feature = "wasm-connectors"))]
#[allow(clippy::unused_async)] // Signature parity with the feature-on loader.
pub async fn load_wasm_connectors(
    _host: &mut opensesame_connector_host::HostRuntime,
    _broker: &std::sync::Arc<opensesame_connection_broker::ConnectionBroker>,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        std::env::var(ENV_CONNECTOR_DIR).is_err(),
        "{ENV_CONNECTOR_DIR} is set but this gateway was built without the \
         wasm-connectors feature; refusing to ignore operator intent"
    );
    Ok(())
}
