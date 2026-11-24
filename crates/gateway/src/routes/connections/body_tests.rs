//! Connection route bodies: bounded, strict, decoded once (`BoundedJson`).

use axum::http::StatusCode;

async fn read_body(
    body: impl Into<String>,
) -> super::super::Body<super::super::CreateIntegrationBody> {
    use axum::extract::FromRequest;
    let request = axum::http::Request::builder()
        .method("POST")
        .body(axum::body::Body::from(body.into()))
        .unwrap();
    let Ok(body) =
        super::super::Body::<super::super::CreateIntegrationBody>::from_request(request, &()).await;
    body
}

#[tokio::test]
async fn connection_json_bodies_are_bounded_before_parsing() {
    let Err(error) = super::super::parse_body(read_body("x".repeat(32 * 1024 + 1)).await) else {
        panic!("oversized body accepted");
    };
    assert_eq!(error.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn connection_json_bodies_refuse_unknown_fields_and_malformed_json() {
    for body in [
        r#"{"key":"k","provider_id":"p","display_name":"d","is_admin":true}"#,
        r#"{"key":"k","provider_id":"p""#,
        r#"{"key":1,"provider_id":"p","display_name":"d"}"#,
        r#"[]"#,
    ] {
        let Err(error) = super::super::parse_body(read_body(body).await) else {
            panic!("accepted {body}");
        };
        assert_eq!(error.status(), StatusCode::BAD_REQUEST, "{body}");
    }
}

#[tokio::test]
async fn connection_json_bodies_accept_valid_and_absent_bodies() {
    let Ok(body) = super::super::parse_body(
        read_body(r#"{"key":"k","provider_id":"p","display_name":"d","scopes":["a"]}"#).await,
    ) else {
        panic!("valid body refused");
    };
    assert_eq!((body.key.as_str(), body.scopes.len()), ("k", 1));
    let Ok(empty) = super::super::parse_body(read_body("  ").await) else {
        panic!("absent body refused");
    };
    assert!(empty.key.is_empty());
}
