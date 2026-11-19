//! Exercise the HTTP tracing layer with an actual private-opening response.

use super::*;
use axum::{body::Body, http::Request, routing::post, Router};
use std::io::{self, Write};
use std::sync::Mutex;
use tower::ServiceExt;
use tower_http::trace::TraceLayer;

struct Capture(Arc<Mutex<Vec<u8>>>);

impl Write for Capture {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn http_trace_does_not_record_the_private_response() {
    let (state, headers, _, _) = fixture().await;
    let captured = Arc::new(Mutex::new(Vec::new()));
    let log_buffer = captured.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_ansi(false)
        .without_time()
        .with_max_level(tracing::Level::TRACE)
        .with_writer(move || Capture(log_buffer.clone()))
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);
    let router = Router::new()
        .route("/api/v1/intents", post(create))
        .with_state(state)
        .layer(TraceLayer::new_for_http());
    let mut request = Request::builder()
        .method("POST")
        .uri("/api/v1/intents")
        .header("content-type", "application/json");
    for (name, value) in &headers {
        request = request.header(name, value);
    }
    let response = router
        .oneshot(
            request
                .body(Body::from(
                    json!({
                        "connection_ref": "",
                        "operation": "repository.read",
                        "resource": "repo:acme/catalog",
                        "audience": "https://api.github.com",
                        "parameters": {},
                        "idempotency_key": "trace-opening"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    let response: Value = serde_json::from_slice(&bytes).unwrap();
    let opening = response["intent_opening"]["opening"].as_str().unwrap();
    let logs = String::from_utf8(captured.lock().unwrap().clone()).unwrap();
    assert!(!logs.is_empty());
    assert!(!logs.contains(opening));
    assert!(!logs.contains("intent_opening"));
}
