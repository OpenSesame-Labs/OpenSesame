//! Exercise proxy isolation in a subprocess so other tests' environment is untouched.

use super::*;
use axum::{
    http::StatusCode,
    response::Redirect,
    routing::{any, get},
    Router,
};
use opensesame_storage::Db;
use std::time::Duration;

const TARGET_ENV: &str = "OPENSESAME_TEST_PROXY_TARGET";

#[tokio::test]
#[ignore = "subprocess-only proxy probe"]
async fn proxy_probe() {
    let Ok(target) = std::env::var(TARGET_ENV) else {
        return;
    };
    let proxy = std::env::var("HTTP_PROXY").expect("loopback proxy required");
    assert_loopback(&target, "/probe");
    assert_loopback(&proxy, "");
    for name in ["http_proxy", "ALL_PROXY", "all_proxy"] {
        assert_eq!(std::env::var(name).as_deref(), Ok(proxy.as_str()));
    }
    for name in ["NO_PROXY", "no_proxy"] {
        assert_eq!(std::env::var(name).as_deref(), Ok(""));
    }
    let db = Db::connect_memory().await.unwrap();
    let config = BrokerConfig::in_memory(None, "http://127.0.0.1:1");
    let normal = ConnectionBroker::new(db.pool().clone(), config.clone()).unwrap();
    let isolated = ConnectionBroker::new_without_system_proxy(db.pool().clone(), config).unwrap();
    let normal_mock = normal
        .credentialed_egress_client("mock", &target)
        .await
        .unwrap();
    let isolated_mock = isolated
        .credentialed_egress_client("mock", &target)
        .await
        .unwrap();
    assert_eq!(
        normal
            .http
            .get(&target)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "proxy"
    );
    for client in [&isolated.http, &normal_mock, &isolated_mock] {
        assert_eq!(
            client
                .get(&target)
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "target"
        );
    }
    let redirect = target.replace("/probe", "/redirect");
    for client in [&normal.http, &normal_mock, &isolated.http, &isolated_mock] {
        assert_eq!(
            client.get(&redirect).send().await.unwrap().status(),
            StatusCode::TEMPORARY_REDIRECT
        );
    }
}

fn assert_loopback(raw: &str, path: &str) {
    let parsed = url::Url::parse(raw).expect("valid loopback URL");
    let port = parsed.port().expect("explicit port");
    assert_eq!(raw, format!("http://127.0.0.1:{port}{path}"));
}

#[tokio::test]
async fn testkit_clients_ignore_the_process_proxy() {
    let target = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target_url = format!("http://{}/probe", target.local_addr().unwrap());
    let proxy_url = format!("http://{}", proxy.local_addr().unwrap());
    let target_task = tokio::spawn(async move {
        let routes = Router::new()
            .route("/redirect", get(|| async { Redirect::temporary("/probe") }))
            .fallback(any(|| async { "target" }));
        let _ = axum::serve(target, routes).await;
    });
    let proxy_task = tokio::spawn(async move {
        let routes = Router::new()
            .route("/redirect", get(|| async { Redirect::temporary("/probe") }))
            .fallback(any(|| async { "proxy" }));
        let _ = axum::serve(proxy, routes).await;
    });

    let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "constructor::tests::proxy_probe",
            "--ignored",
            "--nocapture",
        ])
        .env_clear()
        .env(TARGET_ENV, target_url)
        .env("HTTP_PROXY", &proxy_url)
        .env("http_proxy", &proxy_url)
        .env("ALL_PROXY", &proxy_url)
        .env("all_proxy", &proxy_url)
        .env("NO_PROXY", "")
        .env("no_proxy", "")
        .kill_on_drop(true);
    let result = tokio::time::timeout(Duration::from_secs(15), command.output())
        .await
        .expect("proxy subprocess timed out")
        .expect("proxy subprocess failed to start");
    target_task.abort();
    proxy_task.abort();
    assert!(
        result.status.success(),
        "proxy subprocess failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(
        String::from_utf8_lossy(&result.stdout).contains("1 passed"),
        "proxy subprocess did not run its probe"
    );
}
