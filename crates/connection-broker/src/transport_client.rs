//! Building one scoped connector client: which addresses it may dial, and
//! the TLS profile it presents (ADR 0132, CONN-POOLS/CONN-EXECUTE).
//!
//! Two fences live here. The **address** fence refuses an upstream that
//! resolves to somebody's internal network — loopback, link-local, private,
//! carrier-NAT, unique-local — because a public-looking name whose DNS answer
//! points inward is exactly how a credentialed request gets aimed at a
//! metadata service (AT-CONNECTOR-EGRESS). The **profile** fence is that the
//! client is built from the *resolved* trust bundle and identity only: the
//! injected `rustls::ClientConfig` is the whole of its trust, it is https
//! only, it verifies the exact configured server identity whatever address it
//! dialed, and it is pinned to the one authority the egress fence cleared.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use opensesame_domain::transport::TransportError;
use opensesame_invoke_through::{EgressRule, Invoker, TlsClientSpec};
use opensesame_transport_security::{
    client_config, dial_name, ClientProfile, TlsIdentity, TrustBundle,
};

use super::ConnectionTransport;

/// An address no upstream connector may be dialed at, whatever DNS answered:
/// loopback, link-local, private, unspecified, multicast, or IPv6 unique-local.
/// Checked on the *resolved* address, after the name lookup, because a name
/// that looks public may answer with an internal one.
#[must_use]
pub fn is_internal(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_multicast()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.octets()[0] == 0
                // 100.64.0.0/10 (RFC 6598 carrier NAT) and 169.254.0.0/16 are
                // both routes to somebody else's internal network.
                || (v4.octets()[0] == 100 && (64..128).contains(&v4.octets()[1]))
                || (v4.octets()[0..3] == [192, 0, 0])
                || (v4.octets()[0] == 198 && (18..=19).contains(&v4.octets()[1]))
                || v4.octets()[0] >= 240
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                // fe80::/10 link-local and fc00::/7 unique-local.
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                // Deprecated site-local, local-use translation, discard-only,
                // Teredo and documentation prefixes are not public services.
                || (v6.segments()[0] & 0xffc0) == 0xfec0
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || v6.segments()[0..3] == [0x0064, 0xff9b, 1]
                || v6.segments()[0..4] == [0x0100, 0, 0, 0]
                || v6.segments()[0..2] == [0x2001, 0]
                || v6.segments()[0..3] == [0x2001, 2, 0]
                || (v6.segments()[0..2] == [0x2001, 0x0db8])
                || (v6.segments()[0] == 0x3fff && (v6.segments()[1] & 0xf000) == 0)
                || v6.to_ipv4().is_some_and(is_internal_v4)
                || embedded_v4(v6.segments()).is_some_and(is_internal_v4)
        }
    }
}

fn embedded_v4(segments: [u16; 8]) -> Option<std::net::Ipv4Addr> {
    let from_pair =
        |hi: u16, lo: u16| std::net::Ipv4Addr::from((u32::from(hi) << 16) | u32::from(lo));
    if segments[0] == 0x0064 && segments[1] == 0xff9b && segments[2..6] == [0, 0, 0, 0] {
        return Some(from_pair(segments[6], segments[7]));
    }
    (segments[0] == 0x2002).then(|| from_pair(segments[1], segments[2]))
}

fn is_internal_v4(v4: std::net::Ipv4Addr) -> bool {
    is_internal(IpAddr::V4(v4))
}

/// The one authority a pooled client may dial, and the addresses the fence
/// already cleared for it.
#[derive(Clone, Debug)]
pub struct PinnedAuthority {
    pub label: String,
    pub host: String,
    pub addrs: Vec<SocketAddr>,
}

/// The one client for one scope.
///
/// # Errors
///
/// `MalformedConfiguration` when a configured trust profile has no server
/// name, or when the client config cannot be built from the resolved profile.
pub fn build_invoker(
    transport: &ConnectionTransport,
    identity: Option<&Arc<TlsIdentity>>,
    trust: Option<&Arc<TrustBundle>>,
    authority: &PinnedAuthority,
    rules: Vec<EgressRule>,
    allow_loopback: bool,
) -> Result<Invoker, TransportError> {
    let Some(trust) = trust else {
        // No configured trust profile: the connection uses the Host's ordinary
        // Web PKI client. It must still dial the vetted addresses rather than
        // resolve the host again. `mtls_required` never reaches this branch.
        let invoker = Invoker::with_pinned(rules, &authority.host, &authority.addrs);
        return Ok(if allow_loopback {
            invoker.allow_http_for_tests()
        } else {
            invoker
        });
    };
    let server_name = transport
        .server_name
        .as_ref()
        .ok_or_else(|| TransportError::malformed("a trust profile requires a server name"))?
        .policy();
    let profile = ClientProfile {
        server_trust: trust.as_ref().clone(),
        server_name: server_name.clone(),
        identity: identity.map(Arc::clone),
        min_version: opensesame_domain::transport::TlsVersion::Tls13,
    };
    let config = client_config(&profile)?;
    let spec = TlsClientSpec {
        config: Arc::new(config),
        server_name: Some(dial_name(&server_name, &authority.host)?),
        pinned: Some((authority.host.clone(), authority.addrs.clone())),
    };
    let invoker = Invoker::with_tls(rules, &spec);
    Ok(if allow_loopback {
        invoker.allow_http_for_tests()
    } else {
        invoker
    })
}

#[cfg(all(test, target_os = "linux"))]
#[path = "transport_client_tests.rs"]
mod tests;
