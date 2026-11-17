#![cfg(feature = "testkit")]

use opensesame_gateway::testkit::HostTestkit;
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn http() -> Client {
    Client::builder().no_proxy().build().unwrap()
}

#[tokio::test]
async fn isolated_environment_probe() {
    let Ok(ambient_token) = std::env::var("OPENSESAME_TEST_AMBIENT_TOKEN") else {
        return;
    };
    let host = HostTestkit::new().await.unwrap();
    assert_ne!(host.operator_token(), ambient_token);
    let server = host.start().await.unwrap();
    let base = server.base_url();
    let client = http();
    let ambient = client
        .get(format!("{base}/api/v1/whoami"))
        .bearer_auth(format!("operator:{ambient_token}"))
        .send()
        .await
        .unwrap();
    assert_eq!(ambient.status(), StatusCode::UNAUTHORIZED);
    let own = client
        .get(format!("{base}/api/v1/whoami"))
        .bearer_auth(format!("operator:{}", host.operator_token()))
        .send()
        .await
        .unwrap();
    assert_eq!(own.status(), StatusCode::OK);
    server.close().await.unwrap();
}

#[tokio::test]
async fn fixture_does_not_inherit_host_configuration_or_operator_credentials() {
    let proxy = format!(
        "http://{}:{}@127.0.0.1:1",
        uuid::Uuid::new_v4(),
        uuid::Uuid::new_v4()
    );
    let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", "isolated_environment_probe", "--nocapture"])
        .env_clear()
        .env("OPENSESAME_TEST_AMBIENT_TOKEN", "ambient-fixture-value")
        .env("OPENSESAME_OPERATOR_TOKEN", "ambient-fixture-value")
        .env("OPENSESAME_CONNECTION_KEY", "not-a-valid-key")
        .env("OPENSESAME_OPENBAO_URL", "http://127.0.0.1:1")
        .env("OPENSESAME_OPENFGA_URL", "http://127.0.0.1:1")
        .env("OPENSESAME_TASKBUS", "nats")
        .env("NATS_URL", "nats://127.0.0.1:1")
        .env("HTTP_PROXY", &proxy)
        .env("http_proxy", &proxy)
        .kill_on_drop(true);
    let result = tokio::time::timeout(std::time::Duration::from_secs(15), command.output())
        .await
        .expect("isolation subprocess timed out")
        .expect("isolation subprocess failed to start");
    assert!(
        result.status.success(),
        "isolation subprocess failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(
        String::from_utf8_lossy(&result.stdout).contains("1 passed"),
        "isolation subprocess did not run its probe"
    );
}

#[tokio::test]
async fn host_admission_and_isolation_use_the_real_router() {
    let first = HostTestkit::new().await.unwrap();
    let second = HostTestkit::new().await.unwrap();
    assert_ne!(first.operator_token(), second.operator_token());
    let first_server = first.start().await.unwrap();
    let second_server = second.start().await.unwrap();
    let base = first_server.base_url();
    let parsed = reqwest::Url::parse(&base).unwrap();
    assert_eq!(parsed.scheme(), "http");
    assert_eq!(parsed.host_str(), Some("127.0.0.1"));
    assert!(parsed.port().is_some_and(|port| port != 0));
    let other = second_server.base_url();
    let client = http();

    let live = client
        .get(format!("{base}/health/live"))
        .send()
        .await
        .unwrap();
    assert_eq!(live.status(), StatusCode::OK);
    assert_eq!(live.text().await.unwrap(), "ok");
    let unauthenticated = client
        .get(format!("{base}/api/v1/connections"))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);
    let wrong_host = client
        .get(format!("{other}/api/v1/connections"))
        .bearer_auth(format!("operator:{}", first.operator_token()))
        .send()
        .await
        .unwrap();
    assert_eq!(wrong_host.status(), StatusCode::UNAUTHORIZED);

    let own = client
        .get(format!("{base}/api/v1/connections"))
        .bearer_auth(format!("operator:{}", first.operator_token()))
        .send()
        .await
        .unwrap();
    assert_eq!(own.status(), StatusCode::OK);
    assert_eq!(
        own.json::<Value>().await.unwrap(),
        json!({"connections": []})
    );
    let browser = client
        .get(format!("{base}/api/v1/connections"))
        .header("origin", "https://example.test")
        .bearer_auth(format!("operator:{}", first.operator_token()))
        .send()
        .await
        .unwrap();
    assert_eq!(browser.status(), StatusCode::UNAUTHORIZED);

    let forged_agent = client
        .get(format!("{base}/api/v1/whoami"))
        .bearer_auth(format!("agent-capability:{}", "a".repeat(64)))
        .send()
        .await
        .unwrap();
    assert_eq!(forged_agent.status(), StatusCode::UNAUTHORIZED);
    for (method, path) in [
        (reqwest::Method::POST, "/api/v1/connections"),
        (reqwest::Method::POST, "/api/v1/intents"),
        (reqwest::Method::GET, "/api/v1/providers"),
    ] {
        let response = client
            .request(method, format!("{base}{path}"))
            .bearer_auth(format!("operator:{}", first.operator_token()))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
    }
    first_server.close().await.unwrap();
    second_server.close().await.unwrap();
}

#[tokio::test]
async fn closing_a_host_closes_existing_keep_alive_connections() {
    let fixture = HostTestkit::new().await.unwrap();
    let server = fixture.start().await.unwrap();
    let base = server.base_url();
    let address = base.strip_prefix("http://").unwrap();
    let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
    stream
        .write_all(
            b"GET /health/live HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n",
        )
        .await
        .unwrap();
    let mut response = Vec::new();
    let mut buffer = [0_u8; 512];
    loop {
        let count =
            tokio::time::timeout(std::time::Duration::from_secs(2), stream.read(&mut buffer))
                .await
                .expect("health response arrived")
                .unwrap();
        assert!(count > 0);
        response.extend_from_slice(&buffer[..count]);
        if response.ends_with(b"\r\n\r\nok") {
            break;
        }
        assert!(response.len() < 4096);
    }
    server.close().await.unwrap();
    let after = tokio::time::timeout(std::time::Duration::from_secs(2), stream.read(&mut buffer))
        .await
        .expect("the existing connection closed");
    assert!(matches!(after, Ok(0) | Err(_)));
}

#[tokio::test]
#[ignore = "requires Node and installed workspace dependencies"]
async fn typescript_api_client_exercises_the_real_host() {
    let fixture = HostTestkit::new().await.unwrap();
    let server = fixture.start().await.unwrap();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut command = tokio::process::Command::new("node");
    command
        .current_dir(root)
        .arg("node_modules/vitest/vitest.mjs")
        .args([
            "run",
            "crates/gateway/tests/host-consumer.test.ts",
            "--maxWorkers=1",
        ])
        .env("OPENSESAME_TEST_HOST_URL", server.base_url())
        .env("OPENSESAME_TEST_HOST_OPERATOR", fixture.operator_token())
        .kill_on_drop(true);
    let result = tokio::time::timeout(std::time::Duration::from_secs(60), command.output())
        .await
        .expect("the API client test timed out")
        .expect("Node failed to start");
    server.close().await.unwrap();
    assert!(
        result.status.success(),
        "API client test failed:\n{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}
