use super::*;
use crate::egress::github::map_github_repo_create_error;
use opensesame_storage::Db;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const TOKEN: &str = "race-access-1";

fn auth() -> AuthMethod {
    AuthMethod::OpenRouterPkce {
        authorize_url: "https://example.test/authorize".into(),
        exchange_url: "https://example.test/exchange".into(),
    }
}

fn token() -> TokenSet {
    TokenSet {
        access_token: TOKEN.into(),
        refresh_token: None,
        token_type: "Bearer".into(),
        expires_at: None,
        scopes: Vec::new(),
        configuration: Default::default(),
    }
}

async fn broker(config: crate::BrokerConfig) -> ConnectionBroker {
    let db = Db::connect_memory().await.unwrap();
    ConnectionBroker::new(db.pool().clone(), config).unwrap()
}

fn config() -> crate::BrokerConfig {
    crate::BrokerConfig::in_memory(Some([7; 32]), "http://127.0.0.1:8787")
}

async fn wire(status: &'static str, body: &str) -> (String, tokio::task::JoinHandle<String>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buf = [0_u8; 1024];
        while !request.ends_with(b"\r\n\r\n") {
            let count = stream.read(&mut buf).await.unwrap();
            assert!(count > 0 && request.len() < 8192);
            request.extend_from_slice(&buf[..count]);
        }
        stream.write_all(response.as_bytes()).await.unwrap();
        String::from_utf8(request).unwrap()
    });
    (format!("http://{address}/resource"), task)
}

async fn sent_token(task: tokio::task::JoinHandle<String>) {
    let request = task.await.unwrap().to_ascii_lowercase();
    assert!(request.contains(&format!("authorization: bearer {TOKEN}")));
}

#[tokio::test]
async fn json_escaped_credentials_in_values_and_keys_never_escape() {
    let broker = broker(config()).await;
    for body in [
        r#"{"nested":[{"value":"\u0072ace-access-1"}]}"#,
        r#"{"\u0072ace-access-1":"value"}"#,
    ] {
        assert!(!body.contains(TOKEN));
        let (url, task) = wire("200 OK", body).await;
        let error = broker
            .http_authorized("mock", &auth(), &token(), "GET", &url, None)
            .await
            .unwrap_err();
        assert!(error.contains("contained the injected credential"));
        assert!(!error.contains(TOKEN));
        sent_token(task).await;
    }
}

#[tokio::test]
async fn credentialed_json_error_is_status_only_even_when_provider_reflects_secrets() {
    let broker = broker(config()).await;
    let body = r#"{"raw":"race-access-1","encoded":"cmFjZS1hY2Nlc3MtMQ=="}"#;
    let (url, task) = wire("400 Bad Request", body).await;
    let error = broker
        .http_authorized("mock", &auth(), &token(), "GET", &url, None)
        .await
        .unwrap_err();
    assert!(error.contains("400"));
    assert!(!error.contains(TOKEN));
    assert!(!error.contains("cmFjZS1hY2Nlc3MtMQ=="));
    sent_token(task).await;
}

#[tokio::test]
async fn malformed_json_does_not_echo_the_url_or_response() {
    let broker = broker(config()).await;
    let (url, task) = wire("200 OK", r#"{"bad":"\u0072ace-access-1""#).await;
    let url = format!("{url}?secret={TOKEN}");
    let error = broker
        .http_authorized("mock", &auth(), &token(), "GET", &url, None)
        .await
        .unwrap_err();
    assert_eq!(error, "upstream response was not valid JSON");
    assert!(!error.contains(TOKEN));
    assert!(!error.contains(url.as_str()));
    sent_token(task).await;
}

#[tokio::test]
async fn incomplete_response_does_not_echo_body_or_query() {
    let broker = broker(config()).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buf = [0_u8; 4096];
        stream.read(&mut buf).await.unwrap();
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nrace-access-1")
            .await
            .unwrap();
    });
    let url = format!("http://{address}/resource?secret={TOKEN}");
    let error = broker
        .http_authorized("mock", &auth(), &token(), "GET", &url, None)
        .await
        .unwrap_err();
    assert_eq!(error, "upstream response could not be read");
    assert!(!error.contains(TOKEN));
    assert!(!error.contains(url.as_str()));
    task.await.unwrap();
}

#[tokio::test]
async fn transport_failure_does_not_echo_the_requested_url() {
    let broker = broker(config()).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        drop(stream);
    });
    let url = format!("http://{address}/resource?secret={TOKEN}");
    let error = broker
        .http_authorized("mock", &auth(), &token(), "GET", &url, None)
        .await
        .unwrap_err();
    assert_eq!(error, "upstream request failed");
    assert!(!error.contains(TOKEN));
    assert!(!error.contains(url.as_str()));
    task.await.unwrap();
}

#[tokio::test]
async fn credentialed_json_error_does_not_wait_for_an_unfinished_body() {
    let broker = broker(config()).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buf = [0_u8; 4096];
        stream.read(&mut buf).await.unwrap();
        stream
            .write_all(b"HTTP/1.1 400 Bad Request\r\nTransfer-Encoding: chunked\r\n\r\n")
            .await
            .unwrap();
        std::future::pending::<()>().await;
    });
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        broker.http_authorized(
            "mock",
            &auth(),
            &token(),
            "GET",
            &format!("http://{address}/resource"),
            None,
        ),
    )
    .await;
    task.abort();
    let error = result
        .expect("error body must not delay refusal")
        .unwrap_err();
    assert!(error.contains("400"));
}

#[tokio::test]
async fn normal_mock_json_still_uses_the_real_credentialed_transport() {
    let broker = broker(config()).await;
    let (url, task) = wire("200 OK", r#"{"ok":true}"#).await;
    let result = broker
        .http_authorized("mock", &auth(), &token(), "GET", &url, None)
        .await
        .unwrap();
    assert_eq!(result, json!({"ok": true}));
    sent_token(task).await;
}

#[tokio::test]
async fn mock_localhost_still_dials_only_loopback() {
    let broker = broker(config()).await;
    let (url, task) = wire("200 OK", r#"{"ok":true}"#).await;
    let url = url.replace("127.0.0.1", "localhost");
    let result = broker
        .http_authorized("mock", &auth(), &token(), "GET", &url, None)
        .await
        .unwrap();
    assert_eq!(result, json!({"ok": true}));
    sent_token(task).await;
}

#[tokio::test]
async fn github_permission_error_is_fixed_text_and_retains_its_actionable_hint() {
    let body = r#"{"message":"Resource not accessible by integration","echo":"race-access-1"}"#;
    let (url, task) = wire("403 Forbidden", body).await;
    let client = mock_loopback_client(&Url::parse(&url).unwrap()).unwrap();
    let detail = send_credentialed_json(
        &client,
        "github",
        &auth(),
        &token(),
        reqwest::Method::GET,
        &url,
        None,
    )
    .await
    .unwrap_err();
    assert!(!detail.contains(TOKEN));
    let mapped = map_github_repo_create_error(BrokerError::ExchangeFailed(detail));
    assert_eq!(mapped.code(), "invalid_request");
    assert!(mapped.hint().contains("Install the tenant GitHub App"));
    sent_token(task).await;
}

#[tokio::test]
async fn builtin_private_dns_is_denied_even_if_custom_origin_is_operator_approved() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let origin = format!("https://localhost:{port}");
    let config = config()
        .with_custom_egress_origins(std::slice::from_ref(&origin), &[])
        .unwrap();
    let broker = broker(config).await;
    let url = format!("{origin}/resource");
    let error = broker
        .http_authorized("github", &auth(), &token(), "GET", &url, None)
        .await
        .unwrap_err();
    assert!(error.contains("private"));
    assert!(!error.contains(TOKEN));
    assert!(
        tokio::time::timeout(Duration::from_millis(200), listener.accept())
            .await
            .is_err()
    );
    assert!(broker
        .credentialed_egress_client("custom-example", &url)
        .await
        .is_ok());
    assert!(broker
        .credentialed_egress_client("github", "http://127.0.0.1:1/resource")
        .await
        .is_err());
}
