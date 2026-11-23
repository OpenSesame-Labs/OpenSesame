//! Unit tests for the invoke-through executor, kept beside `invoke.rs` so the
//! executor itself stays inside the module-size budget (ADR 0093).

use super::stub::spawn_stub;
use super::*;
use crate::egress::AuthStyle;

const CANARY: &str = "CANARY-TOKEN-7f3d9b-never-leaks";

fn test_rule(hosts: &'static [&'static str]) -> EgressRule {
    EgressRule {
        provider_id: "github",
        scheme: "https",
        hosts,
        auth: AuthStyle::Bearer,
    }
}

fn test_invoker(hosts: &'static [&'static str]) -> Invoker {
    Invoker::with_rules(vec![test_rule(hosts)]).allow_http_for_tests()
}

fn request(url: String) -> InvokeRequest {
    InvokeRequest {
        provider_id: "github".into(),
        method: "GET".into(),
        url,
        headers: vec![],
        body: None,
        subject: Some("user:alice".into()),
        actor: Some("agent:test".into()),
    }
}

fn canary() -> SecretString {
    SecretString::from(CANARY)
}

#[test]
fn response_debug_never_formats_upstream_data() {
    let response = InvokeResponse {
        status: 200,
        headers: vec![("etag".into(), "1-ssecca-ecar".into())],
        body: Bytes::from_static(b"1-ssecca-ecar"),
        receipt: ReceiptMeta {
            provider_id: "github".into(),
            scheme: "https".into(),
            host: "api.github.com".into(),
            path: "/".into(),
            status: 200,
            latency_ms: 0,
            subject: None,
            actor: None,
            credential_reflected: false,
        },
    };
    let debug = format!("{response:?}");
    assert!(debug.contains("200"));
    assert!(!debug.contains("1-ssecca-ecar"));
}

#[tokio::test]
async fn egress_denial_happens_before_any_connection() {
    let (base, recorded) = spawn_stub(|_| (200, vec![], "ok")).await;
    // The loopback stub is live and would answer, but 127.0.0.1 is not on
    // the github allowlist — the call must die in preflight.
    let invoker = Invoker::with_rules(vec![test_rule(&["api.github.com"])]);
    let err = invoker
        .preflight(request(base))
        .expect_err("loopback host is not allowlisted");
    assert!(matches!(err, InvokeError::EgressDenied { .. }));
    assert!(
        recorded.lock().unwrap().hits.is_empty(),
        "the stub must never be hit"
    );
}

#[tokio::test]
async fn non_default_ports_off_loopback_are_denied() {
    let invoker = Invoker::with_rules(vec![test_rule(&["api.github.com"])]);
    let err = invoker
        .preflight(request("https://api.github.com:8443/zen".into()))
        .expect_err("non-default port");
    assert!(matches!(err, InvokeError::EgressDenied { .. }));
}

#[test]
fn pinned_clients_bind_the_uri_to_the_complete_socket_address() {
    let matching = Invoker::with_pinned_webpki(
        EGRESS_RULES.to_vec(),
        "api.github.com",
        &["127.0.0.1:443".parse().unwrap()],
    );
    matching
        .preflight(request("https://api.github.com/zen".into()))
        .expect("the implicit TLS port matches the pin");

    let mismatched = Invoker::with_pinned_webpki(
        EGRESS_RULES.to_vec(),
        "api.github.com",
        &["127.0.0.1:4443".parse().unwrap()],
    );
    let error = mismatched
        .preflight(request("https://api.github.com/zen".into()))
        .expect_err("the resolver must not rewrite an approved socket port");
    assert!(matches!(error, InvokeError::EgressDenied { .. }));
}

#[tokio::test]
async fn direct_fence_call_cannot_bypass_the_pinned_port_check() {
    let invoker = Invoker::with_pinned_webpki(
        EGRESS_RULES.to_vec(),
        "api.github.com",
        &["127.0.0.1:4443".parse().unwrap()],
    );
    let prepared = invoker
        .fence()
        .preflight(request("https://api.github.com/zen".into()))
        .expect("the shared egress fence does not own client socket pins");
    let error = invoker
        .execute(&canary(), prepared)
        .await
        .expect_err("execution must repeat the client-specific pin check");
    assert!(matches!(error, InvokeError::EgressDenied { .. }));
}

#[tokio::test]
async fn userinfo_urls_are_refused() {
    let invoker = test_invoker(&["127.0.0.1"]);
    let err = invoker
        .preflight(request("http://user:pw@127.0.0.1:1/zen".into()))
        .expect_err("userinfo");
    assert!(matches!(err, InvokeError::InvalidUrl));
}

#[tokio::test]
async fn https_is_required_outside_test_mode() {
    let invoker = Invoker::with_rules(vec![test_rule(&["127.0.0.1"])]);
    let err = invoker
        .preflight(request("http://127.0.0.1:9/zen".into()))
        .expect_err("http without the test flag");
    assert!(matches!(err, InvokeError::HttpsRequired(_)));
}

#[tokio::test]
async fn happy_path_sends_bearer_and_returns_the_upstream_response() {
    let (base, recorded) = spawn_stub(|_| {
        (
            200,
            vec![
                ("content-type", "application/json"),
                ("etag", "\"abc\""),
                ("set-cookie", "session=dropped"),
                ("x-secret-upstream", "dropped"),
            ],
            "{\"zen\":\"ok\"}",
        )
    })
    .await;
    let invoker = test_invoker(&["127.0.0.1"]);
    let response = invoker
        .execute(
            &canary(),
            invoker
                .preflight(request(format!("{base}/zen?access_token=QUERY-SECRET")))
                .unwrap(),
        )
        .await
        .expect("invoked");
    // The token reached the allowlisted host, exactly once, as a bearer.
    let hits = recorded.lock().unwrap();
    assert_eq!(hits.hits.len(), 1);
    assert_eq!(hits.hits[0].0, "/zen");
    assert_eq!(
        hits.hits[0].1.as_deref(),
        Some(format!("Bearer {CANARY}").as_str())
    );
    drop(hits);
    assert_eq!(response.status, 200);
    assert_eq!(response.body.as_ref(), b"{\"zen\":\"ok\"}");
    // Allowlisted response headers survive; everything else is dropped.
    assert!(response.headers.iter().any(|(n, _)| n == "etag"));
    assert!(response.headers.iter().any(|(n, _)| n == "content-type"));
    assert!(!response.headers.iter().any(|(n, _)| n == "set-cookie"));
    assert!(!response
        .headers
        .iter()
        .any(|(n, _)| n == "x-secret-upstream"));
    // Receipt: scheme+host+path, never the query; subject/actor echo.
    assert_eq!(response.receipt.scheme, "http");
    assert_eq!(response.receipt.host, "127.0.0.1");
    assert_eq!(response.receipt.path, "/zen");
    assert_eq!(response.receipt.subject.as_deref(), Some("user:alice"));
    assert_eq!(response.receipt.actor.as_deref(), Some("agent:test"));
    let receipt_json = serde_json::to_string(&response.receipt).unwrap();
    assert!(!receipt_json.contains("QUERY-SECRET"));
    assert!(!receipt_json.contains(CANARY));
}

#[tokio::test]
async fn redirects_are_returned_never_followed() {
    let (base, recorded) = spawn_stub(|req| {
        if req.uri().path() == "/redirect" {
            (302, vec![("content-type", "text/plain")], "see /target")
        } else {
            (200, vec![], "followed!")
        }
    })
    .await;
    let invoker = test_invoker(&["127.0.0.1"]);
    let response = invoker
        .execute(
            &canary(),
            invoker
                .preflight(request(format!("{base}/redirect")))
                .unwrap(),
        )
        .await
        .expect("invoked");
    assert_eq!(response.status, 302);
    assert_eq!(response.body.as_ref(), b"see /target");
    let hits = recorded.lock().unwrap();
    assert_eq!(hits.hits.len(), 1, "the redirect target was chased");
    assert_eq!(hits.hits[0].0, "/redirect");
}

#[tokio::test]
async fn the_token_never_appears_in_error_surfaces() {
    // Transport failure (connection refused on a dead port) must describe
    // the failure class, never the credential.
    let invoker = test_invoker(&["127.0.0.1"]);
    let err = invoker
        .execute(
            &canary(),
            invoker
                .preflight(request("http://127.0.0.1:1/zen".into()))
                .unwrap(),
        )
        .await
        .expect_err("dead port");
    let rendered = format!("{err} / {err:?}");
    assert!(!rendered.contains(CANARY), "{rendered}");

    // A token that cannot be a header value errors without quoting it.
    let bad = SecretString::from("line1\nline2");
    let err = invoker
        .execute(
            &bad,
            invoker
                .preflight(request("http://127.0.0.1:1/zen".into()))
                .unwrap(),
        )
        .await
        .expect_err("malformed token");
    assert!(matches!(err, InvokeError::MalformedToken));
    assert!(!format!("{err} / {err:?}").contains("line1"));
}

#[tokio::test]
async fn request_body_cap_bites_before_connecting() {
    let (base, recorded) = spawn_stub(|_| (200, vec![], "ok")).await;
    let invoker = test_invoker(&["127.0.0.1"]).with_caps(16, DEFAULT_RESPONSE_BODY_CAP);
    let mut req = request(format!("{base}/zen"));
    req.method = "POST".into();
    req.body = Some(Bytes::from(vec![b'x'; 32]));
    let err = invoker.preflight(req).expect_err("oversized body");
    assert!(matches!(err, InvokeError::RequestBodyTooLarge { .. }));
    assert!(recorded.lock().unwrap().hits.is_empty());
}

#[tokio::test]
async fn response_body_is_capped() {
    let (base, _) = spawn_stub(|_| {
        (
            200,
            vec![("content-type", "text/plain")],
            "this body is far longer than sixteen bytes",
        )
    })
    .await;
    let invoker = test_invoker(&["127.0.0.1"]).with_caps(DEFAULT_REQUEST_BODY_CAP, 16);
    let err = invoker
        .execute(&canary(), invoker.preflight(request(base)).unwrap())
        .await
        .expect_err("oversized response");
    assert!(matches!(err, InvokeError::ResponseTooLarge { .. }));
    let rendered = format!("{err} / {err:?}");
    assert!(!rendered.contains(CANARY));
}

#[cfg(test)]
#[path = "invoke_allowlist_tests.rs"]
mod allowlist_tests;
