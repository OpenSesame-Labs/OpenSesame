//! Building one scoped connector client: which addresses it may dial, and
//! the TLS profile it presents (ADR 0132, CONN-POOLS/CONN-EXECUTE).
//!
//! Two fences live here. The **address** fence permits only globally routable
//! unicast answers — because a public-looking name whose DNS answer points at
//! any special-use space is exactly how a credentialed request gets aimed at
//! a metadata service or translation gateway (AT-CONNECTOR-EGRESS). The
//! **profile** fence is that the
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

const NON_GLOBAL_V4: &[(u32, u8)] = &[
    (0x0000_0000, 8),  // 0.0.0.0/8, this network
    (0x0a00_0000, 8),  // 10.0.0.0/8, private
    (0x6440_0000, 10), // 100.64.0.0/10, shared carrier NAT
    (0x7f00_0000, 8),  // 127.0.0.0/8, loopback
    (0xa9fe_0000, 16), // 169.254.0.0/16, link-local
    (0xac10_0000, 12), // 172.16.0.0/12, private
    (0xc000_0000, 24), // 192.0.0.0/24, IETF protocol assignments
    (0xc000_0200, 24), // 192.0.2.0/24, documentation
    (0xc058_6300, 24), // 192.88.99.0/24, deprecated 6to4 relay anycast
    (0xc0a8_0000, 16), // 192.168.0.0/16, private
    (0xc612_0000, 15), // 198.18.0.0/15, benchmarking
    (0xc633_6400, 24), // 198.51.100.0/24, documentation
    (0xcb00_7100, 24), // 203.0.113.0/24, documentation
    (0xe000_0000, 4),  // 224.0.0.0/4, multicast
    (0xf000_0000, 4),  // 240.0.0.0/4, reserved/broadcast
];

fn v4_in_prefix(ip: std::net::Ipv4Addr, network: u32, prefix: u8) -> bool {
    let mask = u32::MAX << (32 - prefix);
    u32::from(ip) & mask == network
}

fn globally_routable_v4(ip: std::net::Ipv4Addr) -> bool {
    // RFC 7723 and PCP anycast are the two globally reachable exceptions in
    // the otherwise special 192.0.0.0/24 protocol-assignment block.
    if matches!(ip.octets(), [192, 0, 0, 9 | 10]) {
        return true;
    }
    !NON_GLOBAL_V4
        .iter()
        .any(|(network, prefix)| v4_in_prefix(ip, *network, *prefix))
}

fn nat64_well_known_embedded_v4(ip: std::net::Ipv6Addr) -> Option<std::net::Ipv4Addr> {
    let octets = ip.octets();
    (octets[..12] == [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0])
        .then(|| std::net::Ipv4Addr::new(octets[12], octets[13], octets[14], octets[15]))
}

fn globally_routable_v6(ip: std::net::Ipv6Addr) -> bool {
    if let Some(embedded) = nat64_well_known_embedded_v4(ip) {
        return globally_routable_v4(embedded);
    }
    let segments = ip.segments();
    // Current IANA global-unicast allocations are within 2000::/3. Staying an
    // allowlist means new special-use ranges fail closed until reviewed.
    if segments[0] & 0xe000 != 0x2000 {
        return false;
    }
    // IETF protocol assignments (Teredo, benchmarking, ORCHID, AMT, and
    // friends), documentation, deprecated 6to4, and the newer 3fff::/20
    // documentation block are not ordinary globally routable destinations.
    !(segments[0] == 0x2001 && segments[1] <= 0x01ff)
        && !(segments[0] == 0x2001 && segments[1] == 0x0db8)
        && segments[0] != 0x2002
        && !(segments[0] == 0x3fff && segments[1] & 0xf000 == 0)
}

/// Whether a resolved address is globally routable unicast according to the
/// reviewed IANA special-purpose registry policy above. The pinned Rust 1.97.1
/// toolchain still exposes `IpAddr::is_global` as unstable, so the policy is
/// kept explicit and table-tested here.
#[must_use]
pub fn is_globally_routable(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => globally_routable_v4(v4),
        IpAddr::V6(v6) => globally_routable_v6(v6),
    }
}

/// An address no upstream connector may dial, whatever DNS answered.
#[must_use]
pub fn is_internal(ip: IpAddr) -> bool {
    !is_globally_routable(ip)
}

fn retain_permitted_addresses(host: &str, addrs: &mut Vec<SocketAddr>, allow_loopback: bool) {
    let literal_loopback =
        allow_loopback && matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]");
    addrs.retain(|addr| {
        if literal_loopback {
            addr.ip().is_loopback()
        } else {
            is_globally_routable(addr.ip())
        }
    });
}

/// The one authority a pooled client may dial, and the addresses the fence
/// already cleared for it.
#[derive(Clone, Debug)]
pub struct PinnedAuthority {
    pub label: String,
    pub host: String,
    pub addrs: Vec<SocketAddr>,
}

/// Resolve an authority exactly once and retain only addresses safe for a
/// credentialed connection. `allow_loopback` is limited to literal loopback
/// targets used by the bundled mock provider and in-process tests; it never
/// admits private, link-local, or other internal DNS answers.
///
/// # Errors
///
/// Returns `MalformedConfiguration` when resolution fails or yields no
/// permitted address.
pub async fn resolve_pinned_authority(
    host: &str,
    port: u16,
    allow_loopback: bool,
) -> Result<PinnedAuthority, TransportError> {
    let host = host.to_ascii_lowercase();
    let mut addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|_| TransportError::malformed("connector authority did not resolve"))?
        .collect();
    retain_permitted_addresses(&host, &mut addrs, allow_loopback);
    if addrs.is_empty() {
        return Err(TransportError::malformed(
            "connector authority resolved to no permitted address",
        ));
    }
    Ok(PinnedAuthority {
        label: format!("{host}:{port}"),
        host,
        addrs,
    })
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
        // Web PKI client. `mtls_required` never reaches here — `resolve_trust`
        // refuses it — so this is only the `server_tls` path. The public WebPKI
        // still verifies the URI hostname, while the dial is restricted to the
        // addresses the preflight resolved and approved.
        let invoker = Invoker::with_pinned_webpki(rules, &authority.host, &authority.addrs);
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

#[cfg(test)]
mod address_tests {
    use super::*;

    fn socket(ip: &str) -> SocketAddr {
        SocketAddr::new(ip.parse().unwrap(), 443)
    }

    #[test]
    fn special_use_addresses_are_not_globally_routable() {
        for denied in [
            "0.0.0.0",
            "0.1.2.3",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.0.0.8",
            "192.0.2.1",
            "192.88.99.1",
            "192.168.0.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "240.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "::ffff:8.8.8.8",
            "64:ff9b::a00:1",
            "64:ff9b:1::1",
            "100::1",
            "2001::1",
            "2001:2::1",
            "2001:db8::1",
            "2002:808:808::1",
            "3fff::1",
            "fc00::1",
            "fe80::1",
            "fec0::1",
            "ff02::1",
        ] {
            assert!(is_internal(denied.parse().unwrap()), "{denied}");
        }
        for allowed in [
            "1.1.1.1",
            "8.8.8.8",
            "93.184.216.34",
            "192.0.0.9",
            "192.0.0.10",
            "64:ff9b::808:808",
            "2001:4860:4860::8888",
            "2606:4700:4700::1111",
        ] {
            assert!(is_globally_routable(allowed.parse().unwrap()), "{allowed}");
        }
    }

    #[test]
    fn mixed_answers_keep_only_globally_routable_addresses() {
        let mut addrs = vec![
            socket("10.0.0.1"),
            socket("198.18.0.1"),
            socket("8.8.8.8"),
            socket("64:ff9b::a00:1"),
            socket("2606:4700:4700::1111"),
        ];
        retain_permitted_addresses("api.example", &mut addrs, false);
        assert_eq!(
            addrs,
            vec![socket("8.8.8.8"), socket("2606:4700:4700::1111")]
        );
    }

    #[test]
    fn loopback_exception_is_literal_and_loopback_only() {
        let original = vec![socket("127.0.0.1"), socket("10.0.0.1"), socket("8.8.8.8")];
        let mut literal = original.clone();
        retain_permitted_addresses("localhost", &mut literal, true);
        assert_eq!(literal, vec![socket("127.0.0.1")]);

        let mut named = original;
        retain_permitted_addresses("api.example", &mut named, true);
        assert_eq!(named, vec![socket("8.8.8.8")]);
    }
}
