use super::*;

async fn start(state: AppState) -> Response {
    authorize(
        State(state),
        Json(DeviceAuthorizeRequest {
            client_id: "opensesame-cli".into(),
            scope: None,
        }),
    )
    .await
    .into_response()
}

async fn body(response: Response) -> serde_json::Value {
    let bytes = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn authorization_links_to_the_configured_pages_ceremony() {
    let state = crate::app_state::test_demo_state().await;
    let response = start(state.clone()).await;
    assert_eq!(response.status(), StatusCode::OK);
    let answer = body(response).await;
    assert_eq!(
        answer["verification_uri"],
        "https://pages.test/OpenSesame/device"
    );
    let complete = url::Url::parse(answer["verification_uri_complete"].as_str().unwrap()).unwrap();
    assert_eq!(
        complete.origin().ascii_serialization(),
        "https://pages.test"
    );
    assert_eq!(complete.path(), "/OpenSesame/device");
    assert_eq!(
        complete.query_pairs().collect::<Vec<_>>(),
        vec![(
            "user_code".into(),
            answer["user_code"].as_str().unwrap().into()
        )]
    );
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM host_device_codes")
        .fetch_one(state.db.pool())
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn missing_pages_configuration_is_actionable_and_creates_no_grant() {
    let mut state = crate::app_state::test_demo_state().await;
    state.client_app_url = None;
    let response = start(state.clone()).await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let answer = body(response).await;
    assert_eq!(answer["error"], "device_approval_unavailable");
    assert!(answer["message"]
        .as_str()
        .unwrap()
        .contains("administrator"));
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM host_device_codes")
        .fetch_one(state.db.pool())
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
#[ignore = "requires Node and installed workspace dependencies"]
async fn public_sdk_script_exercises_real_host_and_cleans_up() {
    let state = crate::app_state::test_demo_state().await;
    let repository_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("gateway crate lives under the repository root");
    assert!(repository_root
        .join("scripts/test/customer-sdk-live.mts")
        .is_file());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = crate::routes::router(state.clone());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        tokio::process::Command::new("node")
            .args(["--import", "tsx", "scripts/test/customer-sdk-live.mts"])
            .current_dir(repository_root)
            .env("OPENSESAME_TEST_HOST_URL", format!("http://{address}"))
            .env("OPENSESAME_OPERATOR_TOKEN", &state.operator_token)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .expect("SDK regression timed out")
    .expect("Node could not start");
    server.abort();
    assert!(
        output.status.success(),
        "SDK regression failed: {} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM host_native_sessions")
        .fetch_one(state.db.pool())
        .await
        .unwrap();
    assert_eq!(count, 0, "the script must withdraw all sessions");
}
