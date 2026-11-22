use super::*;

#[tokio::test]
async fn a_chunk_whose_body_does_not_match_its_digest_is_refused() {
    // The gateway forwards ciphertext it cannot read, but it can still tell
    // that an object filed under this digest would never reassemble.
    let st = state_with_broker().await;
    let token = operator(&st);
    let connection = make_connection(&st, "dropbox").await;
    let app = app(st);
    app.clone()
        .oneshot(put_target_req(
            &token,
            &json!({"connection_id": connection, "folder_path": "/OpenSesame"}),
        ))
        .await
        .unwrap();

    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/api/v1/attachments/replicate/chunk?digest={}",
                    "ab".repeat(32)
                ))
                .header("x-opensesame-operator", &token)
                .header("content-type", "application/octet-stream")
                .body(Body::from(b"not the bytes that hash to that".to_vec()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body_json(res).await["error"], "digest_mismatch");
}

#[tokio::test]
async fn replicating_without_a_target_says_what_to_configure() {
    let st = state_with_broker().await;
    let token = operator(&st);
    let payload = b"sealed chunk bytes".to_vec();
    let digest = blake3::hash(&payload).to_hex().to_string();
    let res = app(st)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/api/v1/attachments/replicate/chunk?digest={digest}"
                ))
                .header("x-opensesame-operator", &token)
                .header("content-type", "application/octet-stream")
                .body(Body::from(payload))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let got = body_json(res).await;
    assert_eq!(got["error"], "no_attachment_target");
    assert!(
        got["hint"].as_str().unwrap_or_default().contains("PUT"),
        "the refusal should name the fix: {got}"
    );
}

#[tokio::test]
async fn a_body_over_the_chunk_limit_is_rejected_by_the_router() {
    // The limit is a router layer, so this asserts the wiring, not just the
    // constant: a body one byte past the ceiling must never reach the
    // handler, let alone the provider.
    let st = state_with_broker().await;
    let token = operator(&st);
    let oversize = vec![0u8; MAX_CHUNK_BODY + 1];
    let digest = blake3::hash(&oversize).to_hex().to_string();
    let res = app(st)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/api/v1/attachments/replicate/chunk?digest={digest}"
                ))
                .header("x-opensesame-operator", &token)
                .header("content-type", "application/octet-stream")
                .body(Body::from(oversize))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn a_body_at_the_chunk_limit_is_accepted_by_the_router() {
    // The counterpart: the ceiling must not be off by one against what the
    // store actually writes. This gets past the router and stops at the
    // missing target, which is how we know the limit let it through.
    let st = state_with_broker().await;
    let token = operator(&st);
    let at_limit = vec![7u8; MAX_CHUNK_BODY];
    let digest = blake3::hash(&at_limit).to_hex().to_string();
    let res = app(st)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/api/v1/attachments/replicate/chunk?digest={digest}"
                ))
                .header("x-opensesame-operator", &token)
                .header("content-type", "application/octet-stream")
                .body(Body::from(at_limit))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_ne!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body_json(res).await["error"], "no_attachment_target");
}

#[tokio::test]
async fn a_traversing_manifest_path_is_refused() {
    let st = state_with_broker().await;
    let token = operator(&st);
    let res = app(st)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/attachments/replicate/manifest?path=../../escape")
                .header("x-opensesame-operator", &token)
                .header("content-type", "application/octet-stream")
                .body(Body::from(b"sealed manifest".to_vec()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body_json(res).await["error"], "invalid_path");
}

#[test]
fn folder_paths_must_be_absolute_and_traversal_free() {
    assert!(valid_folder_path("/OpenSesame/attachments"));
    assert!(valid_folder_path("/a"));
    // These all end up interpolated into an upload path.
    assert!(!valid_folder_path(""));
    assert!(!valid_folder_path("relative/path"));
    assert!(!valid_folder_path("/trailing/"));
    assert!(!valid_folder_path("/has/../traversal"));
    assert!(!valid_folder_path("/has//empty"));
    assert!(!valid_folder_path("/has/./dot"));
    assert!(!valid_folder_path("/has\\backslash"));
    assert!(!valid_folder_path("/has\u{0}nul"));
    assert!(!valid_folder_path(&format!("/{}", "a".repeat(600))));
}

#[test]
fn logical_paths_are_relative_and_traversal_free() {
    assert!(valid_logical_path("Taxes/2025"));
    assert!(valid_logical_path("one"));
    assert!(!valid_logical_path("/absolute"));
    assert!(!valid_logical_path("../escape"));
    assert!(!valid_logical_path("has//empty"));
    assert!(!valid_logical_path("trailing/"));
    assert!(!valid_logical_path("has\\backslash"));
    assert!(!valid_logical_path(""));
}

#[test]
fn digests_are_strict_hex() {
    assert!(valid_digest(&"a".repeat(64)));
    assert!(valid_digest(&"0123456789abcdef".repeat(4)));
    assert!(!valid_digest(&"a".repeat(63)));
    assert!(!valid_digest(&"a".repeat(65)));
    assert!(!valid_digest(&"g".repeat(64)));
    assert!(!valid_digest("../../etc/passwd"));
    assert!(!valid_digest(""));
}

#[test]
fn rendered_dropbox_upload_matches_the_historical_request() {
    let shape = upload_shape("dropbox").expect("dropbox declares a shape");
    let path = "/OpenSesame/attachments/objects/ab/abcd.oschunk";
    let (url, headers) = render_upload(shape, path).expect("renders");
    assert_eq!(url, "https://content.dropboxapi.com/2/files/upload");
    assert_eq!(headers.len(), 1);
    assert_eq!(headers[0].0, "Dropbox-API-Arg");
    // Same JSON the retired dropbox_arg() helper produced (key order is
    // not significant to Dropbox; value equality is the invariant).
    let rendered: serde_json::Value = serde_json::from_str(&headers[0].1).expect("json");
    assert_eq!(
        rendered,
        serde_json::json!({ "path": path, "mode": "overwrite", "mute": true })
    );
}

#[test]
fn header_paths_cannot_break_out_of_the_template() {
    let shape = upload_shape("dropbox").expect("shape");
    let (_, headers) =
        render_upload(shape, "/evil\"},\"mode\":\"add").expect("still renders, encoded");
    let value = &headers[0].1;
    let parsed: serde_json::Value = serde_json::from_str(value).expect("stays valid JSON");
    assert_eq!(parsed["mode"], "overwrite");
    assert!(render_upload(shape, "\u{0}binary").is_none());
}

#[test]
fn providers_without_a_shape_are_refused() {
    assert!(upload_shape("github").is_none());
    assert!(upload_shape("no-such-provider").is_none());
}
