//! Scope checks for a client pinned to a vetted authority.

use std::net::{IpAddr, SocketAddr};

use super::Invoker;
use crate::egress::EgressRule;
use crate::error::InvokeError;
use crate::fence::PreparedRequest;
use crate::tls::build_pinned_client;

impl Invoker {
    /// Use ordinary Web PKI with the addresses already vetted for one host.
    /// The client refuses requests outside that host and port, even when a
    /// caller supplies a request preflighted by a different fence.
    #[must_use]
    pub fn with_pinned(rules: Vec<EgressRule>, host: &str, addrs: &[SocketAddr]) -> Self {
        let mut invoker = Self::from_client(build_pinned_client(host, addrs), rules);
        invoker.pinned = Some((host.to_owned(), addrs.to_vec()));
        invoker
    }

    /// Check a request prepared by another fence before opening a credential.
    /// Literal IP URLs need this check too: Hyper may bypass its DNS resolver
    /// for them, so the literal must itself be among the pinned addresses.
    ///
    /// # Errors
    ///
    /// Returns an egress denial if the request is outside the pinned scope.
    pub fn ensure_pinned_destination(&self, prepared: &PreparedRequest) -> Result<(), InvokeError> {
        let Some((host, addrs)) = &self.pinned else {
            return Ok(());
        };
        let port = prepared.effective_port();
        let literal = prepared
            .host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>();
        let valid = prepared.host.eq_ignore_ascii_case(host)
            && !addrs.is_empty()
            && addrs.iter().all(|addr| addr.port() == port)
            && literal
                .ok()
                .is_none_or(|ip| addrs.iter().any(|addr| addr.ip() == ip));
        if !valid {
            return Err(InvokeError::EgressDenied {
                provider: prepared.provider_id.clone(),
                host: prepared.host.clone(),
            });
        }
        Ok(())
    }
}
