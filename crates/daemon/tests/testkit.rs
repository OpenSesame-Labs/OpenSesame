#![cfg(feature = "testkit")]

// Exercise the CLI's actual consumer, including its loopback and error checks.
#[path = "../../../apps/cli/src/daemon_helpers.rs"]
mod cli_consumer;

use opensesame_daemon::test_fixtures::DaemonTestkit;
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn http() -> Client {
    Client::builder().no_proxy().build().unwrap()
}

#[tokio::test]
async fn close_ends_an_existing_keep_alive_connection() {
    let fixture = DaemonTestkit::new();
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
        assert!(count > 0, "connection closed before the response");
        response.extend_from_slice(&buffer[..count]);
        if response
            .windows(b"{\"status\":\"ok\"}".len())
            .any(|part| part == b"{\"status\":\"ok\"}")
        {
            break;
        }
        assert!(response.len() < 4096);
    }
    server.close().await.unwrap();
    let after = tokio::time::timeout(std::time::Duration::from_secs(2), stream.read(&mut buffer))
        .await
        .expect("the existing connection closed");
    assert!(
        matches!(after, Ok(0) | Err(_)),
        "connection remained usable"
    );
}

#[tokio::test]
async fn cli_helper_grant_flow_and_operator_refusals() {
    let fixture = DaemonTestkit::new();
    let server = fixture.start().await.unwrap();
    let base = server.base_url();
    let client = http();

    let health = client
        .get(format!("{base}/health/live"))
        .send()
        .await
        .unwrap();
    assert_eq!(health.status(), StatusCode::OK);
    assert_eq!(
        health.json::<Value>().await.unwrap(),
        json!({ "status": "ok" })
    );

    let error = cli_consumer::run(
        &base,
        None,
        cli_consumer::HelpersCmd::Allow {
            connection: "conn_fixture".into(),
            installation: Some("777".into()),
        },
    )
    .await
    .expect_err("the real CLI must see an unauthorized response without a token");
    assert!(error.to_string().contains("401"));

    let browser = client
        .put(format!("{base}/v1/helper-mints/conn_fixture"))
        .header("x-opensesame-operator", fixture.operator_token())
        .header("origin", "https://example.test")
        .json(&json!({"installation_id": "777"}))
        .send()
        .await
        .unwrap();
    assert_eq!(browser.status(), StatusCode::UNAUTHORIZED);

    cli_consumer::run(
        &base,
        Some(fixture.operator_token()),
        cli_consumer::HelpersCmd::Allow {
            connection: "conn_fixture".into(),
            installation: Some("777".into()),
        },
    )
    .await
    .unwrap();
    cli_consumer::run(
        &base,
        Some(fixture.operator_token()),
        cli_consumer::HelpersCmd::List,
    )
    .await
    .unwrap();
    let listed = client
        .get(format!("{base}/v1/helper-mints"))
        .header("x-opensesame-operator", fixture.operator_token())
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(
        listed["grants"],
        json!([{ "connection_id": "conn_fixture", "installation_id": "777" }])
    );
    cli_consumer::run(
        &base,
        Some(fixture.operator_token()),
        cli_consumer::HelpersCmd::Revoke {
            connection: "conn_fixture".into(),
        },
    )
    .await
    .unwrap();
    let listed = client
        .get(format!("{base}/v1/helper-mints"))
        .header("x-opensesame-operator", fixture.operator_token())
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(listed["grants"], json!([]));

    // The fixture cannot expose discovery, proxying or real credential fill.
    for path in ["/v1/discover", "/host", "/v1/fill"] {
        let response = client
            .post(format!("{base}{path}"))
            .header("x-opensesame-operator", fixture.operator_token())
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
    }
    server.close().await.unwrap();
    assert!(http()
        .get(format!("{base}/health/live"))
        .send()
        .await
        .is_err());
}

#[tokio::test]
async fn seeded_session_capabilities_are_isolated_and_revocable() {
    let first = DaemonTestkit::new();
    let second = DaemonTestkit::new();
    assert_ne!(first.operator_token(), second.operator_token());
    let first_server = first.start().await.unwrap();
    let second_server = second.start().await.unwrap();
    let base = first_server.base_url();
    let other_base = second_server.base_url();
    let client = http();
    let mint_body = json!({"session_id": "session-a", "audience": "test", "scopes": ["read"]});

    let missing = client
        .post(format!("{base}/v1/mint_capability"))
        .header("x-opensesame-operator", first.operator_token())
        .json(&mint_body)
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(missing["error"], "no_session");
    first.seed_session("session-a", "principal-a");
    let mint = client
        .post(format!("{base}/v1/mint_capability"))
        .header("x-opensesame-operator", first.operator_token())
        .json(&mint_body)
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    let id = mint["capability"]["id"].as_str().unwrap();
    assert!(mint["refresh_token"].is_null());
    assert!(mint["webauthn_material"].is_null());
    assert!(mint["secrets"].is_null());

    let inspect = |url: String, token: &str| {
        client
            .post(format!("{url}/v1/introspect_capability"))
            .header("x-opensesame-operator", token)
            .json(&json!({"id": id}))
    };
    let foreign_token = inspect(other_base.clone(), first.operator_token())
        .send()
        .await
        .unwrap();
    assert_eq!(foreign_token.status(), StatusCode::UNAUTHORIZED);
    let other = inspect(other_base, second.operator_token())
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(other["active"], false);
    let active = inspect(base.clone(), first.operator_token())
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(active["active"], true);
    assert_eq!(active["audience"], "test");
    assert_eq!(active["scopes"], json!(["read"]));

    let revoke = client
        .post(format!("{base}/v1/revoke"))
        .header("x-opensesame-operator", first.operator_token())
        .json(&json!({"id": id}))
        .send()
        .await
        .unwrap();
    assert_eq!(revoke.status(), StatusCode::OK);
    assert_eq!(
        inspect(base, first.operator_token())
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap()["active"],
        false
    );
    first_server.close().await.unwrap();
    second_server.close().await.unwrap();
}
