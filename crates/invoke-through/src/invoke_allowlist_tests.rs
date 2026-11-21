//! Caller-supplied headers pass an allowlist before they reach the wire.

use super::*;

#[tokio::test]
async fn caller_headers_are_allowlisted() {
    let invoker = test_invoker(&["127.0.0.1"]);
    for banned in [
        "authorization",
        "cookie",
        "x-api-key",
        "proxy-authorization",
    ] {
        let mut req = request("http://127.0.0.1:1/zen".into());
        req.headers = vec![(banned.into(), "planted".into())];
        let err = invoker.preflight(req).expect_err("banned header");
        assert!(matches!(err, InvokeError::HeaderNotAllowed(_)), "{banned}");
    }
    let mut req = request("http://127.0.0.1:1/zen".into());
    req.headers = vec![
        ("Accept".into(), "application/vnd.github+json".into()),
        ("content-type".into(), "application/json".into()),
        ("USER-AGENT".into(), "my-agent".into()),
    ];
    invoker.preflight(req).expect("allowlisted headers pass");
}

#[tokio::test]
async fn unknown_methods_and_providers_are_refused() {
    let invoker = test_invoker(&["127.0.0.1"]);
    let mut req = request("http://127.0.0.1:1/zen".into());
    req.method = "TRACE".into();
    assert!(matches!(
        invoker.preflight(req).expect_err("trace"),
        InvokeError::MethodNotAllowed(_)
    ));
    let mut req = request("http://127.0.0.1:1/zen".into());
    req.provider_id = "aws".into();
    assert!(matches!(
        invoker.preflight(req).expect_err("aws in v1"),
        InvokeError::UnsupportedProvider(_)
    ));
}

struct StubSource;

impl TokenSource for StubSource {
    fn acquire(&self) -> Result<SecretString, InvokeError> {
        Ok(canary())
    }
}

#[tokio::test]
async fn execute_with_source_acquires_after_preflight() {
    let invoker = Invoker::with_rules(vec![test_rule(&["api.github.com"])]);
    let err = invoker
        .execute_with_source(&StubSource, request("http://127.0.0.1:1/zen".into()))
        .await
        .expect_err("denied in preflight");
    assert!(matches!(err, InvokeError::EgressDenied { .. }));
}

/// An upstream that reflects the presented credential — an echo/debug route,
/// or an error that quotes the bad token — must not become an oracle: the
/// caller gets the response, never the credential inside it. Raw, base64 at
/// every alignment (a reflected `Basic` blob), and percent-encoded forms.
#[tokio::test]
async fn a_reflected_credential_never_reaches_the_caller() {
    const REFLECTED: &str = concat!(
        "{\"echo\":\"Bearer CANARY-TOKEN-7f3d9b-never-leaks\",",
        // base64("x:" + CANARY) — the token at alignment 2 inside a blob.
        "\"basic\":\"eDpDQU5BUlktVE9LRU4tN2YzZDliLW5ldmVyLWxlYWtz\",",
        // base64(CANARY) — alignment 0.
        "\"b64\":\"Q0FOQVJZLVRPS0VOLTdmM2Q5Yi1uZXZlci1sZWFrcw==\"}"
    );
    let (base, _recorded) = spawn_stub(|_| {
        (
            401,
            vec![
                ("content-type", "application/json"),
                ("x-github-request-id", "CANARY-TOKEN-7f3d9b-never-leaks"),
            ],
            REFLECTED,
        )
    })
    .await;
    let invoker = test_invoker(&["127.0.0.1"]);
    let response = invoker
        .execute(
            &canary(),
            invoker.preflight(request(format!("{base}/echo"))).unwrap(),
        )
        .await
        .expect("a 401 is a response, not an error");
    let body = String::from_utf8(response.body.to_vec()).unwrap();
    assert_eq!(response.status, 401);
    assert!(!body.contains(CANARY), "{body}");
    assert!(!body.contains("VE9LRU4tN2YzZDliLW5ldmVyLWxlYWtz"), "{body}");
    assert!(
        !body.contains("LVRPS0VOLTdmM2Q5Yi1uZXZlci1sZWFrc"),
        "{body}"
    );
    assert!(body.contains("[redacted:credential]"), "{body}");
    let headers = format!("{:?}", response.headers);
    assert!(!headers.contains(CANARY), "{headers}");
    assert!(response.receipt.credential_reflected);
    let receipt = serde_json::to_string(&response.receipt).unwrap();
    assert!(
        receipt.contains("\"credential_reflected\":true"),
        "{receipt}"
    );
}

/// A response that never mentions the credential passes byte-for-byte, and
/// the receipt does not claim a reflection that did not happen.
#[tokio::test]
async fn an_unreflecting_response_is_returned_unchanged() {
    let (base, _recorded) = spawn_stub(|_| (200, vec![], "{\"zen\":\"Q0FOQVJZ\"}")).await;
    let invoker = test_invoker(&["127.0.0.1"]);
    let response = invoker
        .execute(
            &canary(),
            invoker.preflight(request(format!("{base}/zen"))).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(&response.body[..], b"{\"zen\":\"Q0FOQVJZ\"}");
    assert!(!response.receipt.credential_reflected);
    let receipt = serde_json::to_string(&response.receipt).unwrap();
    assert!(!receipt.contains("credential_reflected"), "{receipt}");
}
