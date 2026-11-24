use axum::{
    body::Body,
    extract::FromRequest,
    http::{header::CONTENT_LENGTH, Request, StatusCode},
    response::IntoResponse,
};
use serde::Deserialize;

use super::{BodyRejection, BoundedJson, BoundedJsonWithRaw};

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Probe {
    name: String,
    #[serde(default)]
    count: u32,
}

fn request(body: impl Into<Body>) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/probe")
        .body(body.into())
        .expect("request")
}

async fn extract<const LIMIT: usize>(
    req: Request<Body>,
) -> Result<BoundedJson<Probe, LIMIT>, BodyRejection> {
    BoundedJson::<Probe, LIMIT>::from_request(req, &()).await
}

#[tokio::test]
async fn a_valid_body_within_the_limit_decodes() {
    let decoded = extract::<64>(request(r#"{"name":"a","count":2}"#))
        .await
        .expect("valid body");
    assert_eq!(
        decoded.0,
        Probe {
            name: "a".into(),
            count: 2
        }
    );
}

#[tokio::test]
async fn a_body_exactly_at_the_limit_decodes() {
    let body = r#"{"name":"abc"}"#;
    assert_eq!(body.len(), 14);
    assert!(extract::<14>(request(body)).await.is_ok());
}

#[tokio::test]
async fn an_oversized_body_is_refused_without_a_content_length() {
    let body = format!(r#"{{"name":"{}"}}"#, "x".repeat(100));
    let refused = extract::<64>(request(body)).await.expect_err("too large");
    assert!(matches!(refused, BodyRejection::TooLarge));
    assert_eq!(
        refused.into_response().status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
}

#[tokio::test]
async fn an_oversized_declared_length_is_refused_before_reading() {
    let req = Request::builder()
        .method("POST")
        .uri("/probe")
        .header(CONTENT_LENGTH, "1048576")
        .body(Body::from(r#"{"name":"a"}"#))
        .expect("request");
    let refused = extract::<64>(req).await.expect_err("declared too large");
    assert!(matches!(refused, BodyRejection::TooLarge));
}

#[tokio::test]
async fn a_streamed_oversized_body_is_refused() {
    let chunks: Vec<Result<&'static [u8], std::io::Error>> =
        vec![Ok(br#"{"name":""#), Ok(&[b'x'; 80]), Ok(br#""}"#)];
    let body = Body::from_stream(futures::stream::iter(chunks));
    let refused = extract::<64>(request(body))
        .await
        .expect_err("streamed too large");
    assert!(matches!(refused, BodyRejection::TooLarge));
}

#[tokio::test]
async fn an_unknown_field_is_refused() {
    let refused = extract::<64>(request(r#"{"name":"a","admin":true}"#))
        .await
        .expect_err("unknown field");
    assert!(matches!(refused, BodyRejection::Malformed(_)));
    assert_eq!(refused.into_response().status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn malformed_json_and_wrong_types_are_refused() {
    for body in [
        "{",
        "not json",
        r#"{"name":1}"#,
        r#"{"count":1}"#,
        r#"{"name":"a"} trailing"#,
        r#"{"name":"a","count":-1}"#,
    ] {
        let refused = extract::<64>(request(body)).await.expect_err(body);
        assert!(matches!(refused, BodyRejection::Malformed(_)), "{body}");
    }
}

#[tokio::test]
async fn an_empty_or_blank_body_is_its_own_refusal() {
    for body in ["", "   \n\t"] {
        let refused = extract::<64>(request(body)).await.expect_err("empty");
        assert!(matches!(refused, BodyRejection::Empty), "{body:?}");
    }
}

#[tokio::test]
async fn deep_nesting_is_refused_not_overflowed() {
    let body = format!("{}{}", "[".repeat(4096), "]".repeat(4096));
    let refused = BoundedJson::<serde_json::Value, 16_384>::from_request(request(body), &())
        .await
        .expect_err("recursion limit");
    assert!(matches!(refused, BodyRejection::Malformed(_)));
}

#[tokio::test]
async fn with_raw_keeps_the_exact_bytes() {
    let body = r#"{ "name" : "a" }"#;
    let decoded = BoundedJsonWithRaw::<Probe, 64>::from_request(request(body), &())
        .await
        .expect("valid body");
    assert_eq!(decoded.raw.as_ref(), body.as_bytes());
    assert_eq!(decoded.value.name, "a");
}

#[test]
fn refusals_never_echo_the_body() {
    let error = serde_json::from_str::<Probe>(r#"{"name":"hunter2-secret","x":1}"#)
        .expect_err("unknown field");
    let refusal = BodyRejection::Malformed(error);
    assert!(!refusal.to_string().contains("hunter2"));
}
