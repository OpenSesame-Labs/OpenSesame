//! Authorized-bytes egress tests split from `web_rotation.rs` (ADR 0093).

use super::*;
use axum::{
    body::Bytes,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post as axum_post,
};
use std::sync::Mutex as StdMutex;

/// How the mock server answers, shared with the handler.
type Answer = Arc<dyn Fn() -> Response + Send + Sync>;
/// Handler state: what has been seen, and how to reply.
type MockState = State<(Arc<StdMutex<Seen>>, Answer)>;

/// What a request actually carried, so a test can assert on the wire and
/// not on what the code claims to have sent.
#[derive(Default)]
struct Seen {
    bodies: Vec<Vec<u8>>,
    auth: Vec<String>,
    extra: Vec<String>,
}

async fn handle_upload(
    State((sink, answer)): MockState,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mut seen = sink.lock().unwrap();
    seen.bodies.push(body.to_vec());
    seen.auth.push(
        headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string(),
    );
    seen.extra.push(
        headers
            .get("dropbox-api-arg")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string(),
    );
    drop(seen);
    answer()
}

/// An activated `mock` connection: Active, with a real sealed credential.
async fn active_mock_connection() -> (Arc<ConnectionBroker>, OrganizationId, String) {
    let (_db, broker, org, integration) =
        organization_oauth_broker_with_token_url(token_server().await).await;
    let connection = broker
        .create_connection(
            &org,
            CreateConnection {
                integration_id: Some(integration),
                ..create("mock")
            },
        )
        .await
        .unwrap();
    let start = broker
        .start_authorization(&org, &connection.connection_id, None, None)
        .await
        .unwrap();
    broker
        .complete_authorization("mock", "the-code", &start.state)
        .await
        .unwrap();
    (broker, org, connection.connection_id)
}

/// A server that records what it received and answers however the test asks.
async fn recording_server(
    answer: impl Fn() -> Response + Clone + Send + Sync + 'static,
) -> (String, Arc<StdMutex<Seen>>) {
    let seen = Arc::new(StdMutex::new(Seen::default()));
    let sink = seen.clone();
    let answer: Answer = Arc::new(answer);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            Router::new()
                .route("/upload", axum_post(handle_upload))
                .route("/elsewhere", axum_post(handle_upload))
                .with_state((sink, answer)),
        )
        .await;
    });
    (format!("http://{address}"), seen)
}

#[tokio::test]
async fn uploads_bytes_with_the_credential_injected() {
    let (broker, org, connection) = active_mock_connection().await;
    let (base, seen) = recording_server(|| (StatusCode::OK, "{}").into_response()).await;

    broker
        .authorized_bytes(
            &org,
            &connection,
            &format!("{base}/upload"),
            &[(
                "Dropbox-API-Arg".to_string(),
                "{\"path\":\"/x\"}".to_string(),
            )],
            b"sealed ciphertext".to_vec(),
        )
        .await
        .expect("upload should succeed");

    let seen = seen.lock().unwrap();
    assert_eq!(seen.bodies, vec![b"sealed ciphertext".to_vec()]);
    assert!(
        seen.auth[0].starts_with("Bearer "),
        "the credential must be injected: {:?}",
        seen.auth[0]
    );
    assert!(!seen.auth[0].contains("Bearer Bearer"));
    assert_eq!(seen.extra[0], "{\"path\":\"/x\"}");
}

#[tokio::test]
async fn refuses_a_url_outside_the_connections_egress_allowlist() {
    let (broker, org, connection) = active_mock_connection().await;
    // The mock provider's catalog egress is 127.0.0.1 over http only.
    for hostile in [
        "https://evil.example.com/upload",
        "http://169.254.169.254/latest/meta-data/",
        "http://127.0.0.1.evil.com/upload",
    ] {
        let error = broker
            .authorized_bytes(&org, &connection, hostile, &[], b"x".to_vec())
            .await
            .expect_err("egress allowlist must refuse this");
        assert_eq!(error.code(), "invalid_request", "for {hostile}");
    }
}

#[tokio::test]
async fn never_follows_a_redirect_and_never_replays_the_token() {
    // The property the dedicated no-redirect client exists for. A default
    // reqwest client would follow this and hand the bearer token to the
    // redirect target — so the assertion that matters is not just that the
    // call failed, but that the second endpoint was never contacted.
    let (broker, org, connection) = active_mock_connection().await;
    let (base, seen) = recording_server(|| {
        Response::builder()
            .status(StatusCode::FOUND)
            .header("location", "/elsewhere")
            .body(axum::body::Body::empty())
            .unwrap()
    })
    .await;

    let error = broker
        .authorized_bytes(
            &org,
            &connection,
            &format!("{base}/upload"),
            &[],
            b"x".to_vec(),
        )
        .await
        .expect_err("a redirect must not be followed");
    assert!(
        error.to_string().contains("redirect"),
        "the refusal should say why: {error}"
    );

    let seen = seen.lock().unwrap();
    assert_eq!(
        seen.auth.len(),
        1,
        "the token must reach the original host once and nowhere else"
    );
}

#[tokio::test]
async fn refuses_caller_headers_the_broker_owns() {
    let (broker, org, connection) = active_mock_connection().await;
    let (base, seen) = recording_server(|| (StatusCode::OK, "{}").into_response()).await;

    for reserved in ["Authorization", "authorization", "Content-Type"] {
        let error = broker
            .authorized_bytes(
                &org,
                &connection,
                &format!("{base}/upload"),
                &[(reserved.to_string(), "attacker".to_string())],
                b"x".to_vec(),
            )
            .await
            .expect_err("a reserved header must be refused");
        assert_eq!(error.code(), "invalid_request", "for {reserved}");
    }
    assert!(
        seen.lock().unwrap().auth.is_empty(),
        "refusal must happen before anything is sent"
    );
}

#[tokio::test]
async fn an_upstream_error_body_is_never_returned() {
    let (broker, org, connection) = active_mock_connection().await;
    // A hostile upstream echoes the credential plus a large body; neither
    // the reflection nor any other provider text may escape.
    let (base, _seen) = recording_server(|| {
        let mut body = "Bearer race-access-1 provider-controlled-detail ".to_string();
        body.push_str(&"A".repeat(50_000));
        (StatusCode::BAD_REQUEST, body).into_response()
    })
    .await;

    let error = broker
        .authorized_bytes(
            &org,
            &connection,
            &format!("{base}/upload"),
            &[],
            b"x".to_vec(),
        )
        .await
        .expect_err("a 400 must surface as an error");
    let text = error.to_string();
    assert!(text.contains("400 Bad Request"), "status is useful: {text}");
    for forbidden in ["race-access-1", "provider-controlled-detail"] {
        assert!(!text.contains(forbidden), "provider text escaped: {text}");
    }
    assert!(
        text.len() < 128,
        "status-only error should stay bounded: {text}"
    );
}

#[tokio::test]
async fn an_upstream_error_does_not_wait_for_an_unfinished_body() {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    let (broker, org, connection) = active_mock_connection().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0_u8; 4096];
        assert!(stream.read(&mut request).await.unwrap() > 0);
        stream
            .write_all(b"HTTP/1.1 400 Bad Request\r\nTransfer-Encoding: chunked\r\n\r\n")
            .await
            .unwrap();
        // Never finish the body. A reader of response.text() hangs here.
        std::future::pending::<()>().await;
    });
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        broker.authorized_bytes(
            &org,
            &connection,
            &format!("http://{address}/upload"),
            &[],
            b"x".to_vec(),
        ),
    )
    .await;
    server.abort();
    let error = result
        .expect("the error body must not delay the refusal")
        .unwrap_err();
    assert!(error.to_string().contains("400"));
}

#[tokio::test]
async fn a_connection_without_an_active_credential_cannot_upload() {
    let (_db, broker, org, integration) =
        organization_oauth_broker_with_token_url(token_server().await).await;
    let pending = broker
        .create_connection(
            &org,
            CreateConnection {
                integration_id: Some(integration),
                ..create("mock")
            },
        )
        .await
        .unwrap();
    let (base, seen) = recording_server(|| (StatusCode::OK, "{}").into_response()).await;

    let error = broker
        .authorized_bytes(
            &org,
            &pending.connection_id,
            &format!("{base}/upload"),
            &[],
            b"x".to_vec(),
        )
        .await
        .expect_err("a pending connection has no credential to inject");
    assert_eq!(error.code(), "needs_reauth");
    assert!(
        seen.lock().unwrap().auth.is_empty(),
        "nothing may be sent without a credential"
    );
}

#[tokio::test]
async fn another_organization_cannot_use_this_connection() {
    let (broker, _org, connection) = active_mock_connection().await;
    let (base, seen) = recording_server(|| (StatusCode::OK, "{}").into_response()).await;

    let error = broker
        .authorized_bytes(
            &OrganizationId::new(),
            &connection,
            &format!("{base}/upload"),
            &[],
            b"x".to_vec(),
        )
        .await
        .expect_err("a connection in another org must not be reachable");
    assert_eq!(error.code(), "connection_not_found");
    assert!(seen.lock().unwrap().auth.is_empty());
}
