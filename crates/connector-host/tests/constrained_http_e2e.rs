//! Constrained HTTP pinning and a real TLS provider response. The production
//! surrogate path refuses a mismatched pinned port; a separately preflighted
//! test-mode request reaches an ephemeral listener and exercises the same
//! opaque result projection on a transformed credential response.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::extract::{Request, State};
use axum::response::Response;
use axum::routing::any;
use axum::Router;
use opensesame_connector_host::{
    opaque_http_result, opensesame_param_digest, HostError, HostRuntime, InvokeRequest,
    RefusalCode, SurrogateSite, SurrogateSpec,
};
use opensesame_domain::transport::{
    TlsVersion, TransportError, TransportPolicy, TrustProfileKind, TrustProfileRef,
};
use opensesame_invoke_through::{Invoker, TlsClientSpec, EGRESS_RULES};
use opensesame_transport_security::testkit::DisposableCa;
use opensesame_transport_security::{
    client_config, ClientProfile, Generation, GenerationCandidate, SecureListener,
    ServerNamePolicy, ServerProfile, TransportGenerations, TrustBundle,
};
use secrecy::SecretString;
use serde_json::{json, Value};

const HOST: &str = "api.github.com";
const CALLER: &str = "demo-conn";
const CONNECTION: &str = "conn://acme/github";
const MATERIAL: &str = "CANARY-e2e-material-9f2c41";

/// One request as the upstream received it.
#[derive(Clone, Debug)]
struct Hit {
    authorization: Vec<String>,
}

#[derive(Clone, Default)]
struct Seen(Arc<Mutex<Vec<Hit>>>);

impl Seen {
    fn hits(&self) -> Vec<Hit> {
        self.0.lock().expect("lock").clone()
    }
}

/// Records the request, then echoes its `Authorization` in the body and a
/// reversible encoding in both the body and an allowlisted response header.
async fn reflect(State(seen): State<Seen>, req: Request) -> Response {
    let (parts, _) = req.into_parts();
    let authorization: Vec<String> = parts
        .headers
        .get_all("authorization")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .map(str::to_owned)
        .collect();
    seen.0.lock().expect("lock").push(Hit {
        authorization: authorization.clone(),
    });
    let echoed = authorization.join(",");
    let reversed: String = echoed.chars().rev().collect();
    Response::builder()
        .status(200)
        .header("content-type", "text/plain")
        .header("etag", reversed.as_str())
        .body(format!("you sent: {echoed}; reversed: {reversed}").into())
        .expect("response")
}

struct Upstream {
    addr: SocketAddr,
    seen: Seen,
    ca: DisposableCa,
    _task: tokio::task::JoinHandle<Result<(), TransportError>>,
}

/// A TLS listener holding a certificate for `api.github.com`, issued by a
/// disposable CA only the test's invoker trusts.
async fn upstream() -> Upstream {
    let ca = DisposableCa::new("upstream");
    let candidate = GenerationCandidate {
        identity: Some(Arc::new(ca.issue_server(HOST).identity())),
        peer_trust: std::collections::BTreeMap::new(),
        own_trust: None,
        identity_required: true,
    };
    let generations = TransportGenerations::new(
        candidate
            .into_generation(1, chrono::Utc::now())
            .expect("generation"),
    );
    let profile = |generation: &Generation| {
        let identity = generation
            .identity
            .clone()
            .ok_or(TransportError::IdentityMissing)?;
        Ok(ServerProfile::new(
            TransportPolicy::ServerTls,
            identity,
            "l2-upstream",
        ))
    };
    let listener = SecureListener::bind("127.0.0.1:0".parse().unwrap(), generations, profile)
        .await
        .expect("bind");
    let addr = listener.local_addr();
    let seen = Seen::default();
    let app = Router::new()
        .fallback(any(reflect))
        .with_state(seen.clone());
    Upstream {
        addr,
        seen,
        ca,
        _task: tokio::spawn(listener.serve(app)),
    }
}

/// The production host allowlist, pinned to the ephemeral listener. Test mode
/// permits its non-default TLS port; the pin must still match the request.
fn invoker(upstream: &Upstream) -> Invoker {
    let trust = TrustBundle::from_pem(
        TrustProfileRef::new("upstream").unwrap(),
        TrustProfileKind::PrivateRoot,
        &upstream.ca.root_pem(),
    )
    .unwrap();
    let profile = ClientProfile {
        server_trust: trust,
        server_name: ServerNamePolicy::Dns(HOST.into()),
        identity: None,
        min_version: TlsVersion::Tls13,
    };
    let spec = TlsClientSpec {
        config: Arc::new(client_config(&profile).expect("client config")),
        server_name: None,
        pinned: Some((HOST.into(), vec![upstream.addr])),
    };
    Invoker::with_tls(EGRESS_RULES.to_vec(), &spec).allow_http_for_tests()
}

fn host() -> (HostRuntime, String) {
    let mut host = HostRuntime::default();
    let surrogate = host
        .register_connection(
            SurrogateSpec {
                provider_id: "github".into(),
                connection_ref: CONNECTION.into(),
                run_id: "run-e2e".into(),
                caller: CALLER.into(),
                site: SurrogateSite::Authorization,
                methods: vec!["GET".into(), "POST".into()],
                path_prefixes: vec!["/".into()],
                expires_at_unix: u64::MAX,
            },
            SecretString::from(MATERIAL),
        )
        .expect("registered");
    (host, surrogate.as_str().to_string())
}

fn request(params: Value) -> InvokeRequest {
    InvokeRequest {
        operation: "http.authorized".into(),
        resource: "repo:acme/x".into(),
        audience: "https://api.github.com".into(),
        parameters_digest: opensesame_param_digest(&params),
        parameters: params,
        authorized_operation: "http.authorized".into(),
        invoke_level: Some(2),
        connection_ref: String::new(),
    }
}

fn repo_read(placeholder: &str) -> Value {
    json!({
        "url": "https://api.github.com/repos/acme/x",
        "connection_ref": CONNECTION,
        "headers": [
            ["accept", "application/vnd.github+json"],
            ["authorization", format!("Bearer {placeholder}")],
        ],
    })
}

#[tokio::test]
async fn pinned_destination_refuses_a_mismatched_listener_port() {
    let upstream = upstream().await;
    let (host, ph) = host();
    let error = host
        .invoke_constrained_http(CALLER, &request(repo_read(&ph)), &invoker(&upstream))
        .await
        .expect_err("port mismatch must be refused");
    assert_eq!(
        error,
        HostError::Connector("upstream request failed".into())
    );
    assert!(upstream.seen.hits().is_empty());
}

#[tokio::test]
async fn real_tls_response_cannot_disclose_a_transformed_credential() {
    let upstream = upstream().await;
    let invoker = invoker(&upstream);
    let prepared = invoker
        .preflight(opensesame_invoke_through::InvokeRequest {
            provider_id: "github".into(),
            method: "GET".into(),
            url: format!("https://{HOST}:{}/repos/acme/x", upstream.addr.port()),
            headers: vec![],
            body: None,
            subject: None,
            actor: None,
        })
        .unwrap();
    let response = invoker
        .execute(&SecretString::from(MATERIAL), prepared)
        .await
        .expect("sent");
    let hits = upstream.seen.hits();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].authorization, vec![format!("Bearer {MATERIAL}")]);
    let reversed: String = MATERIAL.chars().rev().collect();
    assert!(String::from_utf8_lossy(&response.body).contains(&reversed));
    let result = opaque_http_result(&response);
    let summary = result.safe_summary.to_string();
    assert!(!summary.contains(MATERIAL), "{summary}");
    assert!(!summary.contains(&reversed));
    assert_eq!(result.safe_summary, json!({"result":"completed"}));
    assert!(result.external_request_digest.is_none());
}

#[tokio::test]
async fn a_refused_request_never_reaches_the_upstream() {
    // The gist oracle again, against a live upstream: a valid header beside
    // the placeholder in the body. Refused at admission, so not one byte —
    // and not the credential — leaves the host.
    let upstream = upstream().await;
    let (host, ph) = host();
    let gist = json!({
        "url": "https://api.github.com/gists",
        "method": "POST",
        "connection_ref": CONNECTION,
        "headers": [["authorization", format!("Bearer {ph}")]],
        "body": format!("{{\"files\":{{\"a\":{{\"content\":\"{ph}\"}}}}}}"),
    });
    let err = host
        .invoke_constrained_http(CALLER, &request(gist), &invoker(&upstream))
        .await
        .unwrap_err();
    assert_eq!(err, HostError::SurrogateRefused(RefusalCode::Misplaced));
    assert!(upstream.seen.hits().is_empty());
}
