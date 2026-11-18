//! Provider-specific access-token identity probes (login / username).

use crate::config::BrokerConfig;
use crate::error::{BrokerError, Result};
use crate::response_guard::read_bounded_body;
use opensesame_invoke_through::scrub_credential_reflection;

const USER_AGENT: &str = "OpenSesame-Host/0.1";
const MAX_PROBE_RESPONSE_BYTES: usize = 64 * 1024;

pub(crate) async fn probe_access_token_account(
    http: &reqwest::Client,
    config: &BrokerConfig,
    provider_id: &str,
    token: &str,
) -> Result<Option<String>> {
    let bearer = format!("Bearer {token}");
    match provider_id {
        "github" => {
            let url = format!("{}/user", config.github_api_base());
            let request = http
                .get(&url)
                .header("Authorization", bearer)
                .header("Accept", "application/vnd.github+json")
                .header("User-Agent", USER_AGENT)
                .header("X-GitHub-Api-Version", "2022-11-28");
            account_field(request, "GitHub", "login", true, token).await
        }
        "gitlab" => {
            let request = http
                .get("https://gitlab.com/api/v4/user")
                .header("Authorization", bearer)
                .header("User-Agent", USER_AGENT);
            account_field(request, "GitLab", "username", false, token).await
        }
        "bitbucket" => {
            let request = http
                .get("https://api.bitbucket.org/2.0/user")
                .header("Authorization", bearer)
                .header("User-Agent", USER_AGENT);
            account_field(request, "Bitbucket", "username", false, token).await
        }
        "codeberg" => {
            // Forgejo/Gitea PATs use `Authorization: token …`; OAuth access
            // tokens also accept that form on Codeberg.
            let request = http
                .get("https://codeberg.org/api/v1/user")
                .header("Authorization", format!("token {token}"))
                .header("User-Agent", USER_AGENT);
            account_field(request, "Codeberg", "login", false, token).await
        }
        "origin" => {
            // Installation tokens (oit_…) authenticate as Bearer against
            // the Origin REST API. Git HTTPS uses x-access-token separately.
            let res = http
                .get("https://api.cursor.com/v1/origin/rate_limit")
                .header("Authorization", bearer)
                .header("User-Agent", USER_AGENT)
                .send()
                .await
                .map_err(|_| BrokerError::ExchangeFailed("Cursor Origin request failed".into()))?;
            let status = res.status();
            if !(200..300).contains(&status.as_u16()) {
                return Err(BrokerError::ExchangeFailed(format!(
                    "Cursor Origin rejected the token ({status})"
                )));
            }
            Ok(Some("origin".to_string()))
        }
        _ => Ok(None),
    }
}

/// Send a forge's "who am I" request and read one string `field` from the
/// JSON it answers with. `show_body` appends the start of a refusal's body
/// to the error, for the forge whose refusals say why.
async fn account_field(
    request: reqwest::RequestBuilder,
    forge: &str,
    field: &str,
    show_body: bool,
    token: &str,
) -> Result<Option<String>> {
    let mut res = request
        .send()
        .await
        .map_err(|_| BrokerError::ExchangeFailed(format!("{forge} request failed")))?;
    let status = res.status();
    let bytes = read_bounded_body(&mut res, MAX_PROBE_RESPONSE_BYTES)
        .await
        .map_err(|error| BrokerError::ExchangeFailed(format!("{forge} {error}")))?;
    let (safe, credential_reflected) = scrub_credential_reflection(bytes, token);
    let text = String::from_utf8(safe.to_vec()).map_err(|_| {
        BrokerError::ExchangeFailed(format!("{forge} returned a non-UTF-8 response"))
    })?;
    if !(200..300).contains(&status.as_u16()) {
        let detail = if show_body {
            let snippet: String = text.chars().take(160).collect();
            format!(": {snippet}")
        } else {
            String::new()
        };
        return Err(BrokerError::ExchangeFailed(format!(
            "{forge} rejected the token ({status}){detail}"
        )));
    }
    if credential_reflected {
        return Err(BrokerError::ExchangeFailed(format!(
            "{forge} response reflected the submitted credential"
        )));
    }
    let body: serde_json::Value = serde_json::from_str(&text)
        .map_err(|_| BrokerError::ExchangeFailed(format!("{forge} returned invalid JSON")))?;
    Ok(body
        .get(field)
        .and_then(|v| v.as_str())
        .map(std::string::ToString::to_string))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{extract::State, routing::get, Router};
    use base64::Engine as _;

    async fn response_server(
        status: axum::http::StatusCode,
        body: String,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind probe response server");
        let address = listener.local_addr().expect("probe server address");
        let task = tokio::spawn(async move {
            let app = Router::new()
                .route(
                    "/",
                    get(
                        |State((status, body)): State<(axum::http::StatusCode, String)>| async move {
                            (status, body)
                        },
                    ),
                )
                .with_state((status, body));
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{address}/"), task)
    }

    fn percent_encode(value: &str) -> String {
        use std::fmt::Write as _;

        let mut encoded = String::with_capacity(value.len() * 3);
        for byte in value.bytes() {
            write!(&mut encoded, "%{byte:02X}").expect("write to String");
        }
        encoded
    }

    fn json_escape(value: &str) -> String {
        use std::fmt::Write as _;

        let mut encoded = String::new();
        for character in value.chars() {
            let mut units = [0u16; 2];
            for unit in character.encode_utf16(&mut units) {
                write!(&mut encoded, "\\u{unit:04X}").expect("write to String");
            }
        }
        encoded
    }

    async fn probe_body(
        token: &str,
        status: axum::http::StatusCode,
        body: String,
        show_body: bool,
    ) -> Result<Option<String>> {
        let (url, server) = response_server(status, body).await;
        let result = account_field(
            reqwest::Client::new().get(url).bearer_auth(token),
            "TestForge",
            "login",
            show_body,
            token,
        )
        .await;
        server.abort();
        result
    }

    #[tokio::test]
    async fn accepts_a_bounded_non_reflecting_identity() {
        let identity = probe_body(
            "submitted-secret",
            axum::http::StatusCode::OK,
            r#"{"login":"alice"}"#.to_string(),
            true,
        )
        .await
        .expect("valid account response");
        assert_eq!(identity.as_deref(), Some("alice"));
    }

    #[tokio::test]
    async fn reflected_success_identity_is_rejected_in_every_supported_encoding() {
        let ascii = "tok/with+reserved=chars&more";
        let cases = [
            (ascii, ascii.to_string()),
            (ascii, percent_encode(ascii)),
            (ascii, json_escape(ascii)),
            (
                ascii,
                base64::engine::general_purpose::STANDARD.encode(ascii),
            ),
        ];
        for (token, reflected) in cases {
            let error = probe_body(
                token,
                axum::http::StatusCode::OK,
                format!(r#"{{"login":"{reflected}"}}"#),
                true,
            )
            .await
            .expect_err("a reflected identity must fail closed");
            assert_eq!(
                error.to_string(),
                "token exchange failed: TestForge response reflected the submitted credential"
            );
        }
    }

    #[tokio::test]
    async fn reflected_error_detail_is_scrubbed_and_bounded() {
        let token = "tok/with+reserved=chars&more";
        let encoded = percent_encode(token);
        let error = probe_body(
            token,
            axum::http::StatusCode::UNAUTHORIZED,
            format!("provider detail: {encoded}"),
            true,
        )
        .await
        .expect_err("upstream refusal");
        let text = error.to_string();
        assert!(text.contains("[redacted:credential]"), "{text}");
        assert!(!text.contains(token), "{text}");
        assert!(!text.contains(&encoded), "{text}");
        assert!(text.len() < 256, "{text}");
    }

    #[tokio::test]
    async fn oversized_success_body_is_refused_before_json_parsing() {
        let error = probe_body(
            "submitted-secret",
            axum::http::StatusCode::OK,
            "A".repeat(MAX_PROBE_RESPONSE_BYTES + 1),
            true,
        )
        .await
        .expect_err("oversized response");
        let text = error.to_string();
        assert!(text.contains("exceeds the 65536 byte limit"), "{text}");
        assert!(text.len() < 160, "{text}");
    }
}
