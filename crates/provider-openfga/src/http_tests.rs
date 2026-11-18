//! Loopback wire contracts; no proxy, provider account, or external network.

use super::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

async fn request(stream: &mut TcpStream) -> (String, Vec<u8>) {
    let mut bytes = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        let read = stream.read(&mut buffer).await.unwrap();
        assert!(read > 0, "request ended early");
        bytes.extend_from_slice(&buffer[..read]);
        assert!(bytes.len() <= 64 * 1024, "unexpectedly large request");
        if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            let header = String::from_utf8(bytes[..end].to_vec()).unwrap();
            let length = header
                .lines()
                .filter_map(|line| line.split_once(':'))
                .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                .map_or(0, |(_, value)| value.trim().parse::<usize>().unwrap());
            let body = end + 4;
            if bytes.len() >= body + length {
                return (header, bytes[body..body + length].to_vec());
            }
        }
    }
}

async fn reply(stream: &mut TcpStream, status: &str, body: &str, extra: &str) {
    let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}", body.len());
    stream.write_all(response.as_bytes()).await.unwrap();
}

fn client(base: &str, store: &str) -> OpenFgaClient {
    OpenFgaClient::with_builder(
        base,
        store,
        reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(3)),
    )
    .unwrap()
}

#[tokio::test]
async fn remote_pdp_trait_sends_the_tuple_with_higher_consistency() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/prefix", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let (headers, body) = request(&mut stream).await;
        reply(&mut stream, "200 OK", r#"{"allowed":true}"#, "").await;
        (headers, body)
    });
    let client = client(&base, "store-01");
    let tuple = TupleKey {
        user: "user:alice".into(),
        relation: "reader".into(),
        object: "document:one".into(),
    };
    let pdp: &dyn RemotePdp = &client;
    assert!(pdp.check(&tuple).await.unwrap());
    let (headers, body) = server.await.unwrap();
    assert!(headers.starts_with("POST /prefix/stores/store-01/check HTTP/1.1\r\n"));
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        json!({
            "tuple_key": {"user":"user:alice", "relation":"reader", "object":"document:one"},
            "consistency": "HIGHER_CONSISTENCY"
        })
    );
}

#[tokio::test]
async fn all_operations_refuse_redirects_without_contacting_the_target() {
    let source = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target_addr = target.local_addr().unwrap();
    let hits = Arc::new(AtomicUsize::new(0));
    let target_hits = Arc::clone(&hits);
    let target_task = tokio::spawn(async move {
        while let Ok((mut stream, _)) = target.accept().await {
            target_hits.fetch_add(1, Ordering::SeqCst);
            let _ = request(&mut stream).await;
            reply(
                &mut stream,
                "200 OK",
                r#"{"allowed":true,"id":"store"}"#,
                "",
            )
            .await;
        }
    });
    let base = format!("http://{}", source.local_addr().unwrap());
    let source_task = tokio::spawn(async move {
        for _ in 0..5 {
            let (mut stream, _) = source.accept().await.unwrap();
            let _ = request(&mut stream).await;
            reply(
                &mut stream,
                "307 Temporary Redirect",
                "{}",
                &format!("Location: http://{target_addr}/leak\r\n"),
            )
            .await;
        }
    });
    let client = client(&base, "store-01");
    let tuple = TupleKey {
        user: "user:alice".into(),
        relation: "reader".into(),
        object: "document:one".into(),
    };
    assert!(client.health().await.is_err());
    assert!(client.create_store("test").await.is_err());
    assert!(client.write_authorization_model(json!({})).await.is_err());
    assert!(client
        .write_tuples(std::slice::from_ref(&tuple))
        .await
        .is_err());
    assert!(client.check(&tuple).await.is_err());
    source_task.await.unwrap();
    assert_eq!(hits.load(Ordering::SeqCst), 0);
    target_task.abort();
}

#[tokio::test]
async fn invalid_base_or_store_never_reaches_the_listener() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let tuple = TupleKey {
        user: "user:alice".into(),
        relation: "reader".into(),
        object: "document:one".into(),
    };
    for store in ["../other", "%2e%2e", "a/b", "a?b", "a#b"] {
        assert!(matches!(
            client(&base, store).check(&tuple).await,
            Err(OpenFgaError::Config(_))
        ));
    }
    for suffix in ["?x=1", "#fragment"] {
        assert!(matches!(
            client(&format!("{base}{suffix}"), "store-01")
                .check(&tuple)
                .await,
            Err(OpenFgaError::Config(_))
        ));
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
}
