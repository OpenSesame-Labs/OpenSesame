use super::*;
use axum::{http::StatusCode, routing::any, Router};

const CODE: &str = "one-time-manifest-code-123";

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}

async fn response_server(
    status: StatusCode,
    body: String,
) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new().fallback(any(move || {
        let body = body.clone();
        async move { (status, body) }
    }));
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{address}/app-manifests"), server)
}

#[test]
fn conversion_codes_are_a_single_url_path_segment() {
    let url = manifest_conversion_url(
        "https://api.github.com/app-manifests",
        "abc/%2F?next=elsewhere#fragment",
    )
    .unwrap();
    assert_eq!(url.host_str(), Some("api.github.com"));
    assert!(url.query().is_none());
    assert!(url.fragment().is_none());
    assert_eq!(
        url.path(),
        "/app-manifests/abc%2F%252F%3Fnext=elsewhere%23fragment/conversions"
    );
    for bad in ["", ".", "..", "bad\ncode"] {
        assert!(manifest_conversion_url("https://api.github.com/app-manifests", bad).is_err());
    }
}

#[tokio::test]
async fn failures_never_expose_codes_or_response_contents() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let error = convert_manifest_at(&client(), &format!("http://{address}/app-manifests"), CODE)
        .await
        .unwrap_err();
    assert!(!format!("{error:?} {error}").contains(CODE));

    for (status, body) in [
        (StatusCode::BAD_REQUEST, CODE.to_string()),
        (StatusCode::OK, format!("{{\"id\":\"{CODE}\"}}")),
    ] {
        let (base, server) = response_server(status, body).await;
        let error = convert_manifest_at(&client(), &base, CODE)
            .await
            .unwrap_err();
        assert!(!format!("{error:?} {error}").contains(CODE));
        server.abort();
    }
}

#[tokio::test]
async fn a_rejected_conversion_discards_a_reflected_code() {
    let reflected = format!("provider reflected {CODE}");
    let (base, server) = response_server(StatusCode::BAD_REQUEST, reflected.clone()).await;
    let error = convert_manifest_at(&client(), &base, CODE)
        .await
        .unwrap_err();
    server.abort();
    let shown = error.to_string();
    assert!(shown.contains("400"), "{shown}");
    assert!(!shown.contains(CODE), "{shown}");
    assert!(!shown.contains(&reflected), "{shown}");
}

#[tokio::test]
async fn a_successful_conversion_reflecting_the_code_fails_closed() {
    // The code is percent-encoded into the name field: a single-use secret
    // must never be parsed into sealed credentials in any encoding.
    let encoded = CODE
        .bytes()
        .map(|byte| format!("%{byte:02X}"))
        .collect::<Vec<_>>()
        .join("");
    let body = format!(
        r#"{{"id":7,"name":"{encoded}","client_id":"Iv1.public","client_secret":"secret"}}"#
    );
    let (base, server) = response_server(StatusCode::OK, body).await;
    let error = convert_manifest_at(&client(), &base, CODE)
        .await
        .expect_err("a reflected conversion code must fail closed");
    server.abort();
    let shown = error.to_string();
    assert_eq!(
        shown,
        "token exchange failed: GitHub App conversion response reflected the one-time code"
    );
    assert!(!shown.contains(CODE), "{shown}");
    assert!(!shown.contains(&encoded), "{shown}");
}

#[tokio::test]
async fn successful_conversion_is_bounded_and_still_decodes_credentials() {
    let body = r#"{"id":7,"name":"test","client_id":"Iv1.public","client_secret":"secret"}"#;
    let (base, server) = response_server(StatusCode::OK, body.to_string()).await;
    let credentials = convert_manifest_at(&client(), &base, CODE).await.unwrap();
    assert_eq!(credentials.id, 7);
    assert_eq!(credentials.client_secret, "secret");
    server.abort();

    let (base, server) = response_server(
        StatusCode::OK,
        "x".repeat(MAX_MANIFEST_CONVERSION_BYTES + 1),
    )
    .await;
    let error = convert_manifest_at(&client(), &base, CODE)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("too large"));
    server.abort();
}

#[tokio::test]
async fn a_chunked_conversion_cannot_exceed_the_response_limit() {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0_u8; 4096];
        stream.read(&mut request).await.unwrap();
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
            .await
            .unwrap();
        let chunk = vec![b'x'; MAX_MANIFEST_CONVERSION_BYTES + 1];
        let header = format!("{:x}\r\n", chunk.len());
        let _ = stream.write_all(header.as_bytes()).await;
        let _ = stream.write_all(&chunk).await;
        let _ = stream.write_all(b"\r\n0\r\n\r\n").await;
    });
    let base = format!("http://{address}/app-manifests");
    let error = convert_manifest_at(&client(), &base, CODE)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("too large"));
    server.abort();
}

#[tokio::test]
async fn a_failed_conversion_does_not_wait_for_the_response_body() {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0_u8; 4096];
        stream.read(&mut request).await.unwrap();
        stream
            .write_all(b"HTTP/1.1 400 Bad Request\r\nTransfer-Encoding: chunked\r\n\r\n")
            .await
            .unwrap();
        std::future::pending::<()>().await;
    });
    let client = client();
    let base = format!("http://{address}/app-manifests");
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        convert_manifest_at(&client, &base, CODE),
    )
    .await;
    server.abort();
    let error = result
        .expect("error response must not wait for its body")
        .unwrap_err();
    assert!(error.to_string().contains("400"));
    assert!(!error.to_string().contains(CODE));
}
