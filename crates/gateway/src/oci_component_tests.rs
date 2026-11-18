use super::*;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::get;
use axum::Router;
use sha2::Digest;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[test]
fn refs_parse_and_fences_hold() {
    let parsed =
        parse_oci_ref(&format!("ghcr.io/acme/echo@sha256:{}", "a".repeat(64))).expect("parses");
    assert_eq!(parsed.registry, "ghcr.io");
    assert_eq!(parsed.repository, "acme/echo");
    assert!(parsed.digest.starts_with("sha256:"));

    for bad in [
        "ghcr.io/acme/echo:latest",                              // tag, not digest
        &format!("ghcr.io/acme/echo@sha256:{}", "a".repeat(63)), // short digest
        &format!("localhost/acme/echo@sha256:{}", "a".repeat(64)), // blocked host
        &format!("127.0.0.1/acme/echo@sha256:{}", "a".repeat(64)),
        &format!(
            "public.example@127.0.0.1/acme/echo@sha256:{}",
            "a".repeat(64)
        ),
        &format!(
            "public.example:443@127.0.0.1/acme/echo@sha256:{}",
            "a".repeat(64)
        ),
        &format!("public.example/a/../b@sha256:{}", "a".repeat(64)),
        &format!("noslash@sha256:{}", "a".repeat(64)),
    ] {
        assert!(parse_oci_ref(bad).is_err(), "{bad} must be refused");
    }
}

#[tokio::test]
async fn unpinned_components_and_private_destinations_fail_before_network() {
    let reference = format!("not-resolvable.invalid/a@sha256:{}", "a".repeat(64));
    let error = fetch_component(&reference, &HashSet::new(), &[])
        .await
        .unwrap_err();
    assert!(error.to_string().contains("not operator-pinned"));
    let result = Transport::production()
        .get(&Url::parse("https://127.0.0.1/").unwrap(), None)
        .await;
    assert!(result.is_err());
    assert!(parse_token_origins("http://127.0.0.1").is_err());
    assert!(parse_token_origins("https://user@example.com").is_err());
    assert!(parse_token_origins("https://example.com/path").is_err());
    assert!(parse_token_origins("https://auth.example.com:8443").is_ok());
}

#[tokio::test]
async fn a_separate_token_realm_requires_an_explicit_origin() {
    use std::sync::atomic::AtomicUsize;
    let visits = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&visits);
    let app = Router::new().route(
        "/token",
        get(move |headers: HeaderMap| {
            let observed = Arc::clone(&observed);
            async move {
                assert!(!headers.contains_key("authorization"));
                observed.fetch_add(1, Ordering::SeqCst);
                axum::Json(serde_json::json!({"token": "test-token"}))
            }
        }),
    );
    let token_base = Url::parse(&(serve(app).await + "/")).unwrap();
    let registry = Url::parse("https://registry.example/").unwrap();
    let challenge = format!("Bearer realm=\"{}token\",service=\"example\"", token_base);
    let transport = test_transport();
    assert!(anonymous_token(&transport, &registry, &challenge, &[])
        .await
        .is_err());
    assert_eq!(visits.load(Ordering::SeqCst), 0);
    let token = anonymous_token(&transport, &registry, &challenge, &[token_base])
        .await
        .unwrap();
    assert_eq!(token, "test-token");
    assert_eq!(visits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn streamed_responses_stop_at_the_actual_byte_limit() {
    use axum::body::{Body, Bytes};
    use std::convert::Infallible;
    let app = Router::new().route(
        "/stream",
        get(|| async {
            Body::from_stream(futures::stream::iter([
                Ok::<_, Infallible>(Bytes::from_static(b"abc")),
                Ok::<_, Infallible>(Bytes::from_static(b"d")),
            ]))
        }),
    );
    let base = serve(app).await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let response = client.get(format!("{base}/stream")).send().await.unwrap();
    assert!(response.content_length().is_none());
    assert!(read_bounded(response, 3, "test body").await.is_err());
    let response = client.get(format!("{base}/stream")).send().await.unwrap();
    assert_eq!(
        read_bounded(response, 4, "test body").await.unwrap(),
        b"abcd"
    );
}

#[tokio::test]
async fn token_body_is_limited_even_without_content_length() {
    use axum::body::{Body, Bytes};
    use futures::StreamExt;
    use std::convert::Infallible;
    let app = Router::new().route(
        "/token",
        get(|| async {
            Body::from_stream(
                futures::stream::iter([
                    Ok::<_, Infallible>(Bytes::from(vec![b'x'; MAX_TOKEN_BYTES])),
                    Ok::<_, Infallible>(Bytes::from_static(b"x")),
                ])
                .chain(futures::stream::pending()),
            )
        }),
    );
    let base = Url::parse(&(serve(app).await + "/")).unwrap();
    let challenge = format!("Bearer realm=\"{}token\"", base);
    let error = tokio::time::timeout(
        Duration::from_secs(5),
        anonymous_token(&test_transport(), &base, &challenge, &[]),
    )
    .await
    .expect("the cap must reject before the server ends the body")
    .unwrap_err();
    assert!(error.to_string().contains("token response exceeds"));
}

#[tokio::test]
async fn component_body_is_limited_before_the_server_ends_the_stream() {
    use axum::body::{Body, Bytes};
    use futures::StreamExt;
    use std::convert::Infallible;
    let app = Router::new().fallback(get(|| async {
        let chunk = Bytes::from(vec![0_u8; 1024 * 1024]);
        let chunks = (0..65).map(move |_| Ok::<_, Infallible>(chunk.clone()));
        Body::from_stream(futures::stream::iter(chunks).chain(futures::stream::pending()))
    }));
    let base = Url::parse(&(serve(app).await + "/")).unwrap();
    let digest = format!("sha256:{}", "a".repeat(64));
    let error = tokio::time::timeout(
        Duration::from_secs(10),
        fetch_blob_from_base(&test_transport(), &base, "acme/echo", &digest, &[]),
    )
    .await
    .expect("the cap must reject before the server ends the body")
    .unwrap_err();
    assert!(error.to_string().contains("component blob exceeds"));
}

#[tokio::test]
async fn registry_redirect_is_not_followed() {
    use std::sync::atomic::AtomicUsize;
    let visits = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&visits);
    let sink = serve(Router::new().fallback(get(move || {
        let observed = Arc::clone(&observed);
        async move {
            observed.fetch_add(1, Ordering::SeqCst);
            "unexpected"
        }
    })))
    .await;
    let redirect = serve(Router::new().fallback(get(move || {
        let sink = sink.clone();
        async move { axum::response::Redirect::temporary(&sink) }
    })))
    .await;
    let base = Url::parse(&(redirect + "/")).unwrap();
    let digest = format!("sha256:{}", "a".repeat(64));
    assert!(
        fetch_blob_from_base(&test_transport(), &base, "acme/echo", &digest, &[])
            .await
            .is_err()
    );
    assert_eq!(visits.load(Ordering::SeqCst), 0);
}

#[test]
fn bearer_challenges_parse_strictly() {
    let fields = parse_bearer_challenge(
        r#"Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:a/b:pull""#,
    )
    .expect("parses");
    assert_eq!(fields[0], ("realm".into(), "https://ghcr.io/token".into()));
    assert!(parse_bearer_challenge("Basic realm=x").is_none());
    assert!(parse_bearer_challenge(r#"Bearer realm="a\"b""#).is_none());
}

fn test_transport() -> Transport {
    Transport::testing(
        reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap(),
    )
}

async fn serve(app: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}")
}

#[tokio::test(flavor = "multi_thread")]
async fn fetches_and_verifies_a_blob_through_the_token_flow() {
    let blob = b"component-bytes".to_vec();
    let digest = format!("sha256:{}", hex::encode(sha2::Sha256::digest(&blob)));
    let challenged = Arc::new(AtomicBool::new(false));

    // Bind first so the 401 challenge can name this server's own /token
    // endpoint as the realm.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let realm = format!("http://{addr}/token");
    let state = (blob.clone(), Arc::clone(&challenged), realm);

    let app = Router::new()
        .route(
            "/token",
            get(|| async { axum::Json(serde_json::json!({"token": "anon-token"})) }),
        )
        .route("/v2/acme/echo/blobs/{digest}", get(challenge_then_serve))
        .with_state(state);
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let http = test_transport();
    let base = Url::parse(&format!("http://{addr}/")).unwrap();
    let bytes = fetch_blob_from_base(&http, &base, "acme/echo", &digest, &[])
        .await
        .expect("full token flow fetch");
    assert_eq!(bytes, b"component-bytes");
    assert!(
        challenged.load(Ordering::SeqCst),
        "the 401 leg must have run"
    );
}

/// Blob bytes, the "was challenged" flag, and the realm to advertise.
type ChallengeState = (Vec<u8>, Arc<AtomicBool>, String);
/// A 401 carrying exactly one `www-authenticate` header.
type ChallengeResponse = (StatusCode, [(&'static str, String); 1]);

/// Answer the first request with a token challenge, then serve the blob.
///
/// Named rather than inline so the two-leg flow reads as two legs; as a
/// closure inside `Router::route` it nested four deep.
async fn challenge_then_serve(
    State((blob, challenged, realm)): State<ChallengeState>,
    headers: HeaderMap,
) -> Result<Vec<u8>, ChallengeResponse> {
    let Some(authorization) = headers.get("authorization") else {
        challenged.store(true, Ordering::SeqCst);
        return Err((
            StatusCode::UNAUTHORIZED,
            [(
                "www-authenticate",
                format!(
                    "Bearer realm=\"{realm}\",service=\"test\",scope=\"repository:acme/echo:pull\""
                ),
            )],
        ));
    };
    assert_eq!(authorization, "Bearer anon-token");
    Ok(blob)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wrong_digest_is_refused_even_from_a_cooperative_registry() {
    let blob = b"honest-bytes".to_vec();
    let app = Router::new().route(
        "/v2/acme/echo/blobs/{digest}",
        get(move || std::future::ready(blob.clone())),
    );
    let base = Url::parse(&(serve(app).await + "/")).unwrap();
    let http = test_transport();

    let pinned_wrong = format!("sha256:{}", "b".repeat(64));
    let err = fetch_blob_from_base(&http, &base, "acme/echo", &pinned_wrong, &[])
        .await
        .expect_err("digest mismatch must refuse");
    assert!(err.to_string().contains("does not match pinned"));

    let honest = format!(
        "sha256:{}",
        hex::encode(sha2::Sha256::digest(b"honest-bytes"))
    );
    let bytes = fetch_blob_from_base(&http, &base, "acme/echo", &honest, &[])
        .await
        .expect("honest digest fetches");
    assert_eq!(bytes, b"honest-bytes");
}
