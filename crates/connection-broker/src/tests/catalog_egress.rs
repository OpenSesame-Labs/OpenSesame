//! The connector catalog and credentialed egress through it.

use axum::response::IntoResponse;

use super::*;

fn percent_encode_all(value: &str) -> String {
    use std::fmt::Write as _;

    let mut encoded = String::with_capacity(value.len() * 3);
    for byte in value.bytes() {
        write!(&mut encoded, "%{byte:02X}").expect("write to String");
    }
    encoded
}

#[test]
fn credentialed_sync_responses_remain_body_blind() {
    let source = include_str!("../sync_target.rs");
    let production = source.split("#[cfg(test)]").next().unwrap();
    for body_read in [
        "response.text()",
        "response.bytes()",
        "response.json",
        "response.chunk",
    ] {
        assert!(!production.contains(body_read), "body read: {body_read}");
    }
}

#[test]
fn every_network_catalog_connector_has_a_generic_execution_contract() {
    for provider in catalog::all().expect("catalog") {
        if matches!(&provider.auth, catalog::AuthMethod::Configuration) {
            continue;
        }
        // Wallet issuers are list-only metadata (empty operations); they must
        // not enter invoke_network_json, so they have no execution contract.
        if matches!(provider.category, catalog::Category::Wallet) && provider.operations.is_empty()
        {
            continue;
        }
        assert_ne!(
            provider.egress.scheme, "none",
            "{} has no egress",
            provider.id
        );
        assert!(
            !provider.operations.is_empty(),
            "{} has no executable operations",
            provider.id
        );
    }
}

#[tokio::test]
async fn catalog_connection_executes_real_credentialed_egress() {
    async fn token(Form(_form): Form<HashMap<String, String>>) -> Json<serde_json::Value> {
        Json(serde_json::json!({
            "access_token": "network-token-do-not-return",
            "token_type": "Bearer"
        }))
    }

    async fn fixture(headers: axum::http::HeaderMap) -> Json<serde_json::Value> {
        Json(serde_json::json!({
            "authorized": headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                == Some("Bearer network-token-do-not-return")
        }))
    }

    async fn leak(headers: axum::http::HeaderMap) -> Json<serde_json::Value> {
        Json(serde_json::json!({
            "echo": headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
        }))
    }

    async fn base64_leak(headers: axum::http::HeaderMap) -> Json<serde_json::Value> {
        use base64::Engine as _;

        let token = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .unwrap_or_default();
        Json(serde_json::json!({
            "echo": base64::engine::general_purpose::STANDARD.encode(token)
        }))
    }

    async fn percent_leak_error(
        headers: axum::http::HeaderMap,
    ) -> impl axum::response::IntoResponse {
        let token = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .unwrap_or_default();
        (
            axum::http::StatusCode::BAD_REQUEST,
            format!("provider detail: {}", percent_encode_all(token)),
        )
    }

    async fn oversized_response() -> String {
        "A".repeat(1024 * 1024 + 1)
    }

    // Port 0, not a fixed one: the mock provider used to bind 9090, which is
    // also `mock-upstream-idp`'s port, so this test failed against a running
    // dev stack and against any second `cargo test` on the same machine.
    // `token_server_with_expiry` above already does it this way.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind bundled mock provider");
    let provider = listener.local_addr().expect("mock provider address");
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            Router::new()
                .route("/token", post(token))
                .route("/fixture", axum::routing::get(fixture))
                .route("/leak", axum::routing::get(leak))
                .route("/base64-leak", axum::routing::get(base64_leak))
                .route(
                    "/percent-leak-error",
                    axum::routing::get(percent_leak_error),
                )
                .route("/oversized", axum::routing::get(oversized_response)),
        )
        .await;
    });

    let config = BrokerConfig::in_memory(Some(KEY), "http://127.0.0.1:8787").with_provider(
        "mock",
        ProviderConfig {
            client_id: Some("mock-client".into()),
            client_secret: Some("mock-secret".into()),
            token_url: Some(format!("http://{provider}/token")),
            ..Default::default()
        },
    );
    let (_db, broker) = broker_with(config).await;
    let organization = OrganizationId::new();
    let connection = broker
        .create_connection(&organization, create("mock"))
        .await
        .expect("create connection");
    let start = broker
        .start_authorization(&organization, &connection.connection_id, None, None)
        .await
        .expect("start authorization");
    broker
        .complete_authorization("mock", "code", &start.state)
        .await
        .expect("complete authorization");

    let response = broker
        .invoke_network_json(
            &organization,
            &connection.connection_id,
            "fixture.read",
            "GET",
            &format!("http://{provider}/fixture"),
            None,
        )
        .await
        .expect("invoke provider");
    assert_eq!(response, serde_json::json!({"authorized": true}));
    assert!(!response.to_string().contains("network-token"));

    let leak = broker
        .invoke_network_json(
            &organization,
            &connection.connection_id,
            "fixture.read",
            "GET",
            &format!("http://{provider}/leak"),
            None,
        )
        .await
        .expect_err("credential-echoing upstream must fail closed");
    assert!(!leak.to_string().contains("network-token"));

    let base64_leak = broker
        .invoke_network_json(
            &organization,
            &connection.connection_id,
            "fixture.read",
            "GET",
            &format!("http://{provider}/base64-leak"),
            None,
        )
        .await
        .expect_err("base64 credential reflection must fail closed");
    assert_eq!(
        base64_leak.to_string(),
        "token exchange failed: upstream response contained the injected credential"
    );

    let percent_leak = broker
        .invoke_network_json(
            &organization,
            &connection.connection_id,
            "fixture.read",
            "GET",
            &format!("http://{provider}/percent-leak-error"),
            None,
        )
        .await
        .expect_err("encoded credential in an error must be refused like a success body");
    let percent_error = percent_leak.to_string();
    // Non-2xx gets the same refusal as 2xx: no scrubbed snippet, no oracle.
    assert_eq!(
        percent_error,
        "token exchange failed: upstream response contained the injected credential"
    );
    assert!(!percent_error.contains("network-token-do-not-return"));
    assert!(!percent_error.contains(&percent_encode_all("network-token-do-not-return")));
    assert!(percent_error.len() < 600);

    let oversized = broker
        .invoke_network_json(
            &organization,
            &connection.connection_id,
            "fixture.read",
            "GET",
            &format!("http://{provider}/oversized"),
            None,
        )
        .await
        .expect_err("oversized response must be refused before JSON parsing");
    let oversized_error = oversized.to_string();
    assert!(oversized_error.contains("exceeds the 1 MiB limit"));
    assert!(oversized_error.len() < 160);
}

#[tokio::test]
async fn reflected_credential_in_response_headers_is_not_returned() {
    async fn token(Form(_form): Form<HashMap<String, String>>) -> Json<serde_json::Value> {
        Json(serde_json::json!({
            "access_token": "network-token-do-not-return",
            "token_type": "Bearer"
        }))
    }

    async fn header_leak(headers: axum::http::HeaderMap) -> impl axum::response::IntoResponse {
        let token = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .unwrap_or_default()
            .to_owned();
        let encoded = percent_encode_all(&token);
        let mut response = (
            axum::http::StatusCode::OK,
            Json(serde_json::json!({"ok": true})),
        )
            .into_response();
        let header_map = response.headers_mut();
        header_map.insert("x-request-id", "req-safe".parse().unwrap());
        header_map.insert(
            "location",
            format!("https://app.example/cb?access_token={token}")
                .parse()
                .unwrap(),
        );
        header_map.insert("cookie", format!("session={token}").parse().unwrap());
        header_map.insert("x-next", format!("next={encoded}").parse().unwrap());
        header_map.insert("set-cookie", "sid=1".parse().unwrap());
        response
    }

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind header-leak provider");
    let provider = listener.local_addr().expect("header-leak address");
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            Router::new()
                .route("/token", post(token))
                .route("/header-leak", axum::routing::get(header_leak)),
        )
        .await;
    });

    let owner = "user:header-owner";
    let config = BrokerConfig::in_memory(Some(KEY), "http://127.0.0.1:8787").with_provider(
        "mock",
        ProviderConfig {
            client_id: Some("mock-client".into()),
            client_secret: Some("mock-secret".into()),
            token_url: Some(format!("http://{provider}/token")),
            ..Default::default()
        },
    );
    let (_db, broker) = broker_with(config).await;
    let organization = OrganizationId::new();
    let connection = broker
        .create_connection(
            &organization,
            CreateConnection {
                owner_subject: Some(owner.into()),
                ..create("mock")
            },
        )
        .await
        .expect("create connection");
    let start = broker
        .start_authorization(&organization, &connection.connection_id, None, None)
        .await
        .expect("start authorization");
    broker
        .complete_authorization("mock", "code", &start.state)
        .await
        .expect("complete authorization");
    let grant = broker
        .owner_invocation_grant(&organization, &connection.connection_id, owner)
        .await
        .expect("owner grant");
    let response = broker
        .authorized_http_for_owner(
            crate::egress::OwnerConnectionExpectation {
                organization_id: &organization,
                connection_id: &connection.connection_id,
                provider_id: "mock",
                owner_subject: owner,
                grant: &grant,
            },
            "GET",
            &format!("http://{provider}/header-leak"),
            None,
        )
        .await
        .expect("header leak is dropped without failing the JSON body");
    let rendered = response
        .headers
        .iter()
        .map(|(name, value)| format!("{name}:{value}"))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!rendered.contains("network-token-do-not-return"));
    assert!(!rendered.contains(&percent_encode_all("network-token-do-not-return")));
    assert!(response
        .headers
        .iter()
        .any(|(name, value)| name.eq_ignore_ascii_case("x-request-id") && value == "req-safe"));
    for dropped in [
        "location",
        "cookie",
        "x-next",
        "set-cookie",
        "authorization",
    ] {
        assert!(
            !response
                .headers
                .iter()
                .any(|(name, _)| name.eq_ignore_ascii_case(dropped)),
            "{dropped} was returned"
        );
    }
    assert_eq!(response.json, serde_json::json!({"ok": true}));
}
