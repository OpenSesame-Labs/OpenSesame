//! Credential-bearing attachment requests stay on the chosen Host origin.

use std::time::Duration;

const TARGET_MAX_BYTES: usize = 16 * 1024;
const TARGET_TIMEOUT: Duration = Duration::from_secs(15);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(120);

pub(super) fn operator_client(base: &str) -> anyhow::Result<reqwest::Client> {
    let origin = reqwest::Url::parse(base)?;
    // Do not replay the operator header through a proxy or redirect. Resolve
    // localhost only to loopback even if the machine's resolver is altered.
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(UPLOAD_TIMEOUT);
    if origin.host_str() == Some("localhost") {
        let port = origin
            .port_or_known_default()
            .ok_or_else(|| anyhow::anyhow!("Host port is unavailable"))?;
        let addresses = [
            std::net::SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, port)),
            std::net::SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, port)),
        ];
        builder = builder.resolve_to_addrs("localhost", &addresses);
    }
    Ok(builder.build()?)
}

pub(super) async fn get_target(
    client: &reqwest::Client,
    base: &str,
    token: &str,
) -> anyhow::Result<serde_json::Value> {
    get_target_with_timeout(client, base, token, TARGET_TIMEOUT).await
}

async fn get_target_with_timeout(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    timeout: Duration,
) -> anyhow::Result<serde_json::Value> {
    tokio::time::timeout(timeout, async {
        let mut response = client
            .get(format!("{base}/api/v1/attachments/target"))
            .header("x-opensesame-operator", token)
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("attachment target request failed"))?;
        if !response.status().is_success() {
            anyhow::bail!(
                "attachment target request failed (HTTP {})",
                response.status().as_u16()
            );
        }
        if response
            .content_length()
            .is_some_and(|len| len > TARGET_MAX_BYTES as u64)
        {
            anyhow::bail!("attachment target response exceeds the size limit");
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| anyhow::anyhow!("attachment target response failed"))?
        {
            if chunk.len() > TARGET_MAX_BYTES - bytes.len() {
                anyhow::bail!("attachment target response exceeds the size limit");
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("invalid attachment target response"))
    })
    .await
    .map_err(|_| anyhow::anyhow!("attachment target request timed out"))?
}

pub(super) async fn upload(
    client: &reqwest::Client,
    url: &str,
    token: &str,
    version: &str,
    body: Vec<u8>,
) -> anyhow::Result<()> {
    let response = client
        .post(url)
        .header("x-opensesame-operator", token)
        .header("x-opensesame-attachment-target", version)
        .header("Content-Type", "application/octet-stream")
        .body(body)
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("upload request failed or timed out"))?;
    if !response.status().is_success() {
        anyhow::bail!("HTTP {}", response.status().as_u16());
    }
    // The status is all that is trusted. Never buffer or print a Host body,
    // which can reflect the operator credential or stream without limit.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn response_peer(response: Vec<u8>) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let peer = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            assert!(stream.read(&mut request).await.unwrap() > 0);
            // A client rejecting the declared size can close before the body.
            let _ = stream.write_all(&response).await;
        });
        (base, peer)
    }

    #[tokio::test]
    async fn localhost_resolves_to_the_loopback_host() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://localhost:{}", listener.local_addr().unwrap().port());
        let peer = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 4096];
            let read = stream.read(&mut bytes).await.unwrap();
            let request = String::from_utf8_lossy(&bytes[..read]).to_ascii_lowercase();
            assert!(request.contains("x-opensesame-operator: test-token"));
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
        });
        let response = operator_client(&base)
            .unwrap()
            .get(&base)
            .header("x-opensesame-operator", "test-token")
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
        peer.await.unwrap();
    }

    #[tokio::test]
    async fn redirect_never_forwards_the_operator_header() {
        let sink = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let source = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", source.local_addr().unwrap());
        let redirect = format!("http://{}/stolen", sink.local_addr().unwrap());
        let peer = tokio::spawn(async move {
            let (mut stream, _) = source.accept().await.unwrap();
            let mut bytes = [0; 4096];
            assert!(stream.read(&mut bytes).await.unwrap() > 0);
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 302 Found\r\nLocation: {redirect}\r\nContent-Length: 0\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });
        let response = operator_client(&base)
            .unwrap()
            .get(&base)
            .header("x-opensesame-operator", "test-token")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::FOUND);
        peer.await.unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(150), sink.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn target_response_is_bounded_for_declared_and_chunked_bodies() {
        let mut chunked = format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n",
            TARGET_MAX_BYTES + 1
        )
        .into_bytes();
        chunked.extend(vec![b'x'; TARGET_MAX_BYTES + 1]);
        chunked.extend_from_slice(b"\r\n0\r\n\r\n");
        for response in [
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                TARGET_MAX_BYTES + 1
            )
            .into_bytes(),
            chunked,
        ] {
            let (base, peer) = response_peer(response).await;
            let error = get_target(&operator_client(&base).unwrap(), &base, "operator-secret")
                .await
                .unwrap_err();
            assert_eq!(
                error.to_string(),
                "attachment target response exceeds the size limit"
            );
            peer.await.unwrap();
        }
    }

    #[tokio::test]
    async fn target_response_has_a_deadline_even_when_the_body_stalls() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (release, hold) = tokio::sync::oneshot::channel::<()>();
        let peer = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            assert!(stream.read(&mut request).await.unwrap() > 0);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{")
                .await
                .unwrap();
            let _ = hold.await;
        });
        let result = get_target_with_timeout(
            &operator_client(&base).unwrap(),
            &base,
            "operator-secret",
            Duration::from_millis(100),
        )
        .await;
        assert_eq!(
            result.unwrap_err().to_string(),
            "attachment target request timed out"
        );
        let _ = release.send(());
        peer.await.unwrap();
    }

    #[tokio::test]
    async fn target_errors_do_not_reflect_the_operator_credential() {
        for response in [
            b"HTTP/1.1 403 Forbidden\r\nContent-Length: 15\r\n\r\noperator-secret".as_slice(),
            b"HTTP/1.1 200 OK\r\nContent-Length: 15\r\n\r\noperator-secret".as_slice(),
        ] {
            let (base, peer) = response_peer(response.to_vec()).await;
            let error = get_target(&operator_client(&base).unwrap(), &base, "operator-secret")
                .await
                .unwrap_err();
            assert!(!error.to_string().contains("operator-secret"));
            assert!(matches!(
                error.to_string().as_str(),
                "attachment target request failed (HTTP 403)"
                    | "invalid attachment target response"
            ));
            peer.await.unwrap();
        }
    }

    #[tokio::test]
    async fn upload_failure_does_not_read_or_reflect_a_streamed_error_body() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (release, hold) = tokio::sync::oneshot::channel::<()>();
        let peer = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            assert!(stream.read(&mut request).await.unwrap() > 0);
            stream.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 1000000000\r\n\r\noperator-secret").await.unwrap();
            let _ = hold.await;
        });
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            upload(
                &operator_client(&base).unwrap(),
                &base,
                "operator-secret",
                "version",
                b"sealed".to_vec(),
            ),
        )
        .await
        .unwrap();
        assert_eq!(result.unwrap_err().to_string(), "HTTP 502");
        let _ = release.send(());
        peer.await.unwrap();
    }

    #[tokio::test]
    async fn an_unresponsive_upload_fails_without_including_request_data() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (release, hold) = tokio::sync::oneshot::channel::<()>();
        let peer = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            assert!(stream.read(&mut request).await.unwrap() > 0);
            let _ = hold.await;
        });
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_millis(100))
            .build()
            .unwrap();
        let error = upload(
            &client,
            &base,
            "operator-secret",
            "version",
            b"sealed".to_vec(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.to_string(), "upload request failed or timed out");
        let _ = release.send(());
        peer.await.unwrap();
    }
}
