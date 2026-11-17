//! One DNS-pinned, proxy-free client for one credentialed provider request.

use std::time::Duration;

use crate::error::{BrokerError, Result};
use crate::transport::client::resolve_pinned_authority;

/// Credentialed egress travels over https. The single exception is http to
/// loopback, which the catalog permits only for the bundled mock provider.
fn require_secure_egress_url(url: &str) -> Result<()> {
    let parsed =
        url::Url::parse(url).map_err(|_| BrokerError::Invalid("malformed egress url".into()))?;
    let loopback = matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "::1"));
    match parsed.scheme() {
        "https" => Ok(()),
        "http" if loopback => Ok(()),
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

pub(super) async fn credentialed_client(url: &str, timeout: Duration) -> Result<reqwest::Client> {
    require_secure_egress_url(url)?;
    let parsed =
        url::Url::parse(url).map_err(|_| BrokerError::Invalid("malformed egress url".into()))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| BrokerError::Invalid("egress url has no host".into()))?;
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| BrokerError::Invalid("egress url has no port".into()))?;
    let allow_loopback =
        parsed.scheme() == "http" && matches!(host, "127.0.0.1" | "localhost" | "::1");
    let authority = resolve_pinned_authority(host, port, allow_loopback)
        .await
        .map_err(|error| BrokerError::Invalid(error.to_string()))?;
    pinned_http_client(&authority.host, &authority.addrs, timeout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Router};

    #[test]
    fn credentialed_egress_requires_https_except_loopback() {
        assert!(require_secure_egress_url("https://api.github.com/user/repos").is_ok());
        assert!(require_secure_egress_url("http://127.0.0.1:8080/upload").is_ok());
        assert!(require_secure_egress_url("http://localhost:8080/upload").is_ok());
        for refused in [
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
        let error = credentialed_client("https://localhost/secret", Duration::from_secs(1))
            .await
            .expect_err("an internal answer must be refused before a credential is opened");
        assert!(error
            .to_string()
            .contains("resolved to no permitted address"));
    }

    #[tokio::test]
    async fn credentialed_client_dials_only_the_pinned_address() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                Router::new().route("/probe", get(|| async { "pinned" })),
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
