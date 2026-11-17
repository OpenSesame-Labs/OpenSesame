//! Malformed public API paths cannot redirect an account bearer to another origin.
#[path = "common/response_limit_stub.rs"]
mod stub;

use std::sync::atomic::Ordering;

use opensesame_provider_bitwarden::{Client, DeviceIdentity, Endpoints, Error};
use stub::Framing;

fn client(base: &str) -> Client {
    Client::new(
        Endpoints::split(base, base).unwrap(),
        DeviceIdentity::default(),
    )
    .unwrap()
}

#[tokio::test]
async fn malformed_get_and_post_paths_cannot_send_a_bearer_to_another_origin() {
    for post in [false, true] {
        let pinned = stub::spawn(200, Framing::Length(2), b"{}".to_vec(), false).await;
        let other = stub::spawn(200, Framing::Length(2), b"{}".to_vec(), false).await;
        let path = format!("@{}/steal", other.base.strip_prefix("http://").unwrap());
        let api = client(&pinned.base);
        let error = if post {
            api.post_json(
                &path,
                "fixture-bearer",
                &serde_json::json!({"proof":"fixture"}),
            )
            .await
            .unwrap_err()
        } else {
            api.get_json(&path, "fixture-bearer").await.unwrap_err()
        };
        assert!(matches!(error, Error::InvalidServerUrl(_)));
        assert_eq!(pinned.connections.load(Ordering::SeqCst), 0);
        assert_eq!(other.connections.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn injected_url_credentials_are_rejected_even_when_the_origin_matches() {
    for post in [false, true] {
        let pinned = stub::spawn(200, Framing::Length(2), b"{}".to_vec(), false).await;
        let path = format!("@{}/userinfo", pinned.base.strip_prefix("http://").unwrap());
        let api = client(&pinned.base);
        let error = if post {
            api.post_json(&path, "fixture-bearer", &serde_json::json!({}))
                .await
                .unwrap_err()
        } else {
            api.get_json(&path, "fixture-bearer").await.unwrap_err()
        };
        assert!(matches!(error, Error::InvalidServerUrl(_)));
        assert_eq!(pinned.connections.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn ordinary_requests_keep_the_configured_base_prefix_for_get_and_post() {
    for post in [false, true] {
        let pinned = stub::spawn(200, Framing::Length(2), b"{}".to_vec(), false).await;
        let api = client(&format!("{}/mounted/api", pinned.base));
        let response = if post {
            api.post_json("/safe?details=1", "fixture-bearer", &serde_json::json!({}))
                .await
                .unwrap()
        } else {
            api.get_json("/safe?details=1", "fixture-bearer")
                .await
                .unwrap()
        };
        assert_eq!(response, serde_json::json!({}));
        assert_eq!(pinned.connections.load(Ordering::SeqCst), 1);
        assert_eq!(
            pinned.target.lock().unwrap().as_deref(),
            Some("/mounted/api/safe?details=1")
        );
    }
}

#[tokio::test]
async fn cross_origin_downloads_never_inherit_account_bearers_or_cookies() {
    let pinned = stub::spawn(200, Framing::Length(2), b"{}".to_vec(), false).await;
    let storage = stub::spawn(200, Framing::Length(3), b"abc".to_vec(), false).await;
    let api = Client::new(
        Endpoints::split(&pinned.base, &pinned.base)
            .unwrap()
            .with_download_origin(&storage.base)
            .unwrap(),
        DeviceIdentity::default(),
    )
    .unwrap();
    api.get_json("/safe", "fixture-bearer").await.unwrap();
    assert!(pinned.authorization.load(Ordering::SeqCst));
    // The authenticated response sets a sentinel cookie. Download storage is
    // another port on the same host, so enabling a cookie jar would leak it.
    let bytes = api
        .download(&format!("{}/file", storage.base), 3)
        .await
        .unwrap();
    assert_eq!(bytes, b"abc");
    assert_eq!(storage.connections.load(Ordering::SeqCst), 1);
    assert!(!storage.authorization.load(Ordering::SeqCst));
    assert!(!storage.cookie.load(Ordering::SeqCst));
}

#[tokio::test]
async fn downloads_require_the_exact_api_or_explicit_storage_origin() {
    let api_peer = stub::spawn(200, Framing::Length(3), b"api".to_vec(), false).await;
    let other = stub::spawn(200, Framing::Length(3), b"bad".to_vec(), false).await;
    let api = client(&api_peer.base);
    for url in [
        format!("{}/file?signature=secret", other.base),
        "https://untrusted.example/file?signature=secret".to_owned(),
        format!(
            "http://user@{}/file",
            api_peer.base.trim_start_matches("http://")
        ),
        api_peer.base.replacen("http://", "https://", 1) + "/file",
    ] {
        let error = api.download(&url, 3).await.unwrap_err();
        assert!(matches!(error, Error::InvalidServerUrl(_)));
        assert!(!error.to_string().contains("signature=secret"));
    }
    assert_eq!(other.connections.load(Ordering::SeqCst), 0);
    assert_eq!(api_peer.connections.load(Ordering::SeqCst), 0);
    assert_eq!(
        api.download(&format!("{}/file", api_peer.base), 3)
            .await
            .unwrap(),
        b"api"
    );
}

#[test]
fn additional_download_origins_must_be_plain_origins() {
    for origin in [
        "https://storage.example/path",
        "https://storage.example/?signed=secret",
        "https://storage.example/#fragment",
        "https://user@storage.example/",
        "http://storage.example/",
    ] {
        let endpoints = Endpoints::from_server_url("https://vault.example").unwrap();
        assert!(endpoints.with_download_origin(origin).is_err());
    }
}

#[tokio::test]
async fn json_and_download_redirects_never_reach_a_second_origin() {
    for download in [false, true] {
        let sink = stub::spawn(200, Framing::Length(2), b"{}".to_vec(), false).await;
        let redirect = stub::redirect(&format!("{}/leak", sink.base)).await;
        let api = client(&redirect.base);
        let error = if download {
            api.download(&format!("{}/file", redirect.base), 3)
                .await
                .unwrap_err()
        } else {
            api.get_json("/safe", "fixture-bearer").await.unwrap_err()
        };
        assert!(matches!(error, Error::RedirectRefused { status: 302, .. }));
        assert_eq!(redirect.connections.load(Ordering::SeqCst), 1);
        assert_eq!(sink.connections.load(Ordering::SeqCst), 0);
    }
}
