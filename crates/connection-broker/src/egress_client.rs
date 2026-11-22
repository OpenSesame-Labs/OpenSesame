//! One DNS-pinned, proxy-free client for one credentialed provider request.

use std::time::Duration;

use crate::error::{BrokerError, Result};
use crate::transport::client::resolve_pinned_authority;

/// Whether a URL names the literal loopback host. `host_str` brackets IPv6,
/// so the parsed host is compared rather than its text.
fn is_loopback_host(parsed: &url::Url) -> bool {
    match parsed.host() {
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip == std::net::Ipv4Addr::LOCALHOST,
        Some(url::Host::Ipv6(ip)) => ip == std::net::Ipv6Addr::LOCALHOST,
        None => false,
    }
}

/// Credentialed egress travels over https. The single exception is http to
/// loopback, which the catalog permits only for the bundled mock provider.
/// A URL carrying userinfo is refused: the injected credential is the only
/// credential a provider request may carry.
fn require_secure_egress_url(url: &str) -> Result<()> {
    let parsed =
        url::Url::parse(url).map_err(|_| BrokerError::Invalid("malformed egress url".into()))?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(BrokerError::Invalid(
            "credentialed egress url must not carry credentials".into(),
        ));
    }
    match parsed.scheme() {
        "https" => Ok(()),
        "http" if is_loopback_host(&parsed) => Ok(()),
        _ => Err(BrokerError::Invalid(
            "credentialed egress requires https (http is loopback-only)".into(),
        )),
    }
}

fn pinned_http_client(
    host: &str,
    addrs: &[std::net::SocketAddr],
    timeout: Duration,
) -> Result<reqwest::Client> {
    reqwest::Client::builder()
        // A proxy would perform its own lookup and receive the credential,
        // bypassing the address pin entirely.
        .no_proxy()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(host, addrs)
        .build()
        .map_err(|_| BrokerError::Invalid("could not build pinned credential transport".into()))
}

/// `loopback_permitted` is true only for the bundled mock provider; any other
/// catalog provider is refused plain-http loopback before DNS is consulted.
pub(super) async fn credentialed_client(
    url: &str,
    timeout: Duration,
    loopback_permitted: bool,
) -> Result<reqwest::Client> {
    require_secure_egress_url(url)?;
    let parsed =
        url::Url::parse(url).map_err(|_| BrokerError::Invalid("malformed egress url".into()))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| BrokerError::Invalid("egress url has no host".into()))?;
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| BrokerError::Invalid("egress url has no port".into()))?;
    let allow_loopback = parsed.scheme() == "http" && is_loopback_host(&parsed);
    if allow_loopback && !loopback_permitted {
        return Err(BrokerError::Invalid(
            "credentialed egress requires https (http loopback is mock-only)".into(),
        ));
    }
    let authority = resolve_pinned_authority(host, port, allow_loopback)
        .await
        .map_err(|error| BrokerError::Invalid(error.to_string()))?;
    pinned_http_client(&authority.host, &authority.addrs, timeout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Router};

    async fn pinned_response() -> &'static str {
        "pinned"
    }

    #[test]
    fn credentialed_egress_requires_https_except_loopback() {
        assert!(require_secure_egress_url("https://api.github.com/user/repos").is_ok());
        assert!(require_secure_egress_url("http://127.0.0.1:8080/upload").is_ok());
        assert!(require_secure_egress_url("http://localhost:8080/upload").is_ok());
        assert!(require_secure_egress_url("http://[::1]:8080/upload").is_ok());
        for refused in [
            "https://user:pass@api.github.com/user/repos",
            "https://token@api.github.com/user/repos",
            "http://api.github.com/user/repos",
            "http://169.254.169.254/latest/meta-data/",
            "http://127.0.0.1.evil.com/upload",
            "ftp://127.0.0.1/upload",
            "not a url",
        ] {
            assert!(
                require_secure_egress_url(refused).is_err(),
                "{refused} must be refused"
            );
        }
    }

    #[tokio::test]
    async fn credentialed_https_refuses_an_internal_dns_answer() {
        let error = credentialed_client("https://localhost/secret", Duration::from_secs(1), true)
            .await
            .expect_err("an internal answer must be refused before a credential is opened");
        assert!(error
            .to_string()
            .contains("resolved to no permitted address"));
    }

    #[tokio::test]
    async fn plain_http_loopback_is_refused_unless_permitted() {
        let error = credentialed_client("http://127.0.0.1:9/upload", Duration::from_secs(1), false)
            .await
            .expect_err("only the bundled mock may use http loopback");
        assert!(error.to_string().contains("mock-only"));
    }

    #[tokio::test]
    async fn credentialed_client_dials_only_the_pinned_address() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                Router::new().route("/probe", get(pinned_response)),
            )
            .await;
        });
        let client = pinned_http_client("pin.invalid", &[address], Duration::from_secs(2))
            .expect("pinned client");
        let response = client
            .get(format!("http://pin.invalid:{}/probe", address.port()))
            .send()
            .await
            .expect("the explicit pin bypasses ambient DNS")
            .text()
            .await
            .unwrap();
        task.abort();
        assert_eq!(response, "pinned");
    }
}
