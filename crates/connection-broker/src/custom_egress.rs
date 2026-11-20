//! Deployment-approved private origins and pinned custom-provider clients.
//!
//! A tenant can name a provider, but cannot grant it access to the Host's
//! private network. An operator may explicitly allow an exact private origin.

use std::collections::BTreeSet;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use url::{Host, Url};

use crate::catalog::{AuthMethod, Provider};
use crate::config::{ENV_CUSTOM_PRIVATE_ORIGINS, ENV_CUSTOM_TOKEN_ORIGINS};
use crate::error::{BrokerError, Result};
use crate::transport::client::is_internal;

const DNS_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_DNS_ANSWERS: usize = 32;

#[derive(Clone, Debug, Default)]
pub(crate) struct CustomEgressPolicy {
    private_origins: BTreeSet<String>,
    token_origins: BTreeSet<String>,
}

fn origin(raw: &str) -> Result<String> {
    let url =
        Url::parse(raw).map_err(|_| BrokerError::Invalid("invalid custom egress origin".into()))?;
    if url.scheme() != "https"
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(url.path(), "" | "/")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(BrokerError::Invalid(
            "custom egress allowlists require plain HTTPS origins".into(),
        ));
    }
    Ok(url.origin().ascii_serialization())
}

fn env_list(name: &str) -> Vec<String> {
    std::env::var(name)
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

impl CustomEgressPolicy {
    pub(crate) fn new(private: &[String], tokens: &[String]) -> Result<Self> {
        Ok(Self {
            private_origins: private
                .iter()
                .map(|value| origin(value))
                .collect::<Result<_>>()?,
            token_origins: tokens
                .iter()
                .map(|value| origin(value))
                .collect::<Result<_>>()?,
        })
    }

    pub(crate) fn from_env() -> Result<Self> {
        Self::new(
            &env_list(ENV_CUSTOM_PRIVATE_ORIGINS),
            &env_list(ENV_CUSTOM_TOKEN_ORIGINS),
        )
    }

    fn private_allowed(&self, url: &Url) -> bool {
        self.private_origins
            .contains(&url.origin().ascii_serialization())
    }

    fn validate_url(&self, url: &Url) -> Result<()> {
        if url.scheme() != "https"
            || url.host().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(BrokerError::Invalid(
                "custom provider endpoints require HTTPS without userinfo".into(),
            ));
        }
        let address = match url.host() {
            Some(Host::Ipv4(ip)) => Some(IpAddr::V4(ip)),
            Some(Host::Ipv6(ip)) => Some(IpAddr::V6(ip)),
            _ => None,
        };
        if address.is_some_and(|ip| is_internal(ip) && !self.private_allowed(url)) {
            return Err(BrokerError::Invalid(
                "custom provider private origin requires operator approval".into(),
            ));
        }
        Ok(())
    }

    pub(crate) fn validate_token(&self, provider: &Provider, token: &Url) -> Result<()> {
        self.validate_url(token)?;
        let same_origin = provider.egress.authorities.iter().any(|authority| {
            Url::parse(&format!("{}://{authority}/", provider.egress.scheme))
                .is_ok_and(|base| base.origin() == token.origin())
        });
        if !same_origin
            && !self
                .token_origins
                .contains(&token.origin().ascii_serialization())
        {
            return Err(BrokerError::Invalid(
                "custom provider cross-origin token endpoint requires operator approval".into(),
            ));
        }
        Ok(())
    }

    pub(crate) fn validate_provider(&self, provider: &Provider) -> Result<()> {
        for authority in &provider.egress.authorities {
            let base = Url::parse(&format!("{}://{authority}/", provider.egress.scheme))
                .map_err(|_| BrokerError::Invalid("invalid custom provider origin".into()))?;
            self.validate_url(&base)?;
        }
        if let AuthMethod::OAuth2AuthCode { token_url, .. } = &provider.auth {
            let token = Url::parse(token_url).map_err(|_| {
                BrokerError::Invalid("invalid custom provider token endpoint".into())
            })?;
            self.validate_token(provider, &token)?;
        }
        Ok(())
    }

    fn vet(&self, url: &Url, addrs: &[SocketAddr]) -> Result<()> {
        if addrs.is_empty() || addrs.len() > MAX_DNS_ANSWERS {
            return Err(BrokerError::Invalid(
                "custom provider did not resolve".into(),
            ));
        }
        if addrs.iter().any(|addr| match addr.ip() {
            IpAddr::V4(ip) => ip.is_unspecified() || ip.is_multicast() || ip.is_broadcast(),
            IpAddr::V6(ip) => ip.is_unspecified() || ip.is_multicast(),
        }) {
            return Err(BrokerError::Invalid(
                "custom provider resolved to an unusable address".into(),
            ));
        }
        if addrs.iter().any(|addr| is_internal(addr.ip())) && !self.private_allowed(url) {
            return Err(BrokerError::Invalid(
                "custom provider resolves to a private address without operator approval".into(),
            ));
        }
        Ok(())
    }

    fn build_client(
        &self,
        url: &Url,
        addrs: &[SocketAddr],
        timeout: Duration,
    ) -> Result<reqwest::Client> {
        self.validate_url(url)?;
        self.vet(url, addrs)?;
        let mut builder = reqwest::Client::builder()
            .timeout(timeout)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none());
        if let Some(Host::Domain(host)) = url.host() {
            builder = builder.resolve_to_addrs(host, addrs);
        }
        builder
            .build()
            .map_err(|_| BrokerError::Invalid("could not build custom provider transport".into()))
    }

    /// Resolve exactly once, vet every answer, and make a no-proxy,
    /// no-redirect client that dials only those addresses.
    pub(crate) async fn client(&self, url: &Url, timeout: Duration) -> Result<reqwest::Client> {
        self.validate_url(url)?;
        let port = url
            .port_or_known_default()
            .ok_or_else(|| BrokerError::Invalid("invalid custom provider port".into()))?;
        let addrs = match url.host() {
            Some(Host::Domain(host)) => {
                tokio::time::timeout(DNS_TIMEOUT, tokio::net::lookup_host((host, port)))
                    .await
                    .map_err(|_| BrokerError::Invalid("custom provider DNS timed out".into()))?
                    .map_err(|_| BrokerError::Invalid("custom provider did not resolve".into()))?
                    .take(MAX_DNS_ANSWERS + 1)
                    .collect()
            }
            Some(Host::Ipv4(ip)) => vec![SocketAddr::new(IpAddr::V4(ip), port)],
            Some(Host::Ipv6(ip)) => vec![SocketAddr::new(IpAddr::V6(ip), port)],
            None => return Err(BrokerError::Invalid("custom provider needs a host".into())),
        };
        self.build_client(url, &addrs, timeout)
    }
}

#[cfg(test)]
#[path = "custom_egress_tests.rs"]
mod tests;
