//! INV-D2: the Lean owner-egress vectors (spec/formal/invocation) replayed
//! against `authorized_json_for_owner` and `authorized_http_for_owner`.
//!
//! Each case perturbs one input of an owner's otherwise-valid egress. A
//! perturbed grant is also written back to storage, so the stored-grant check
//! cannot mask the guard under test; only the two stored-grant cases differ.

use std::sync::atomic::{AtomicUsize, Ordering};

use opensesame_domain::{Grant, GrantId};

use super::*;

const OWNER: &str = "user:vector-owner";

struct Fixture {
    broker: ConnectionBroker,
    organization: OrganizationId,
    connection: String,
    grant: Grant,
    provider: std::net::SocketAddr,
    effects: Arc<AtomicUsize>,
}

async fn fixture() -> Fixture {
    async fn token(Form(_form): Form<HashMap<String, String>>) -> Json<serde_json::Value> {
        Json(serde_json::json!({"access_token": "vector-token", "token_type": "Bearer"}))
    }
    async fn effect(State(effects): State<Arc<AtomicUsize>>) -> Json<serde_json::Value> {
        effects.fetch_add(1, Ordering::SeqCst);
        Json(serde_json::json!({"ok": true}))
    }
    let effects = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let provider = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/token", post(token))
        .route("/effect", axum::routing::get(effect))
        .with_state(Arc::clone(&effects));
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
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
        .create_connection(
            &organization,
            CreateConnection {
                owner_subject: Some(OWNER.into()),
                ..create("mock")
            },
        )
        .await
        .unwrap()
        .connection_id;
    let start = broker
        .start_authorization(&organization, &connection, None, None)
        .await
        .unwrap();
    broker
        .complete_authorization("mock", "code", &start.state)
        .await
        .unwrap();
    let grant = broker
        .owner_invocation_grant(&organization, &connection, OWNER)
        .await
        .unwrap();
    Fixture {
        broker,
        organization,
        connection,
        grant,
        provider,
        effects,
    }
}

async fn sql(f: &Fixture, query: &str, value: &str, id: &str) {
    sqlx::query(query)
        .bind(value)
        .bind(id)
        .execute(&f.broker.pool)
        .await
        .unwrap();
}

async fn store_grant(f: &Fixture, grant: &Grant) {
    let body = serde_json::to_string(grant).unwrap();
    let id = f.grant.id.to_string();
    sql(
        f,
        "UPDATE grants SET body_json = ? WHERE id = ?",
        &body,
        &id,
    )
    .await;
}

async fn replay(line: &str, api: &str, case: &str, expected: &str) {
    let mut f = fixture().await;
    let (mut provider, mut owner) = ("mock", OWNER);
    let mut url = format!("http://{}/effect", f.provider);
    let mut grant = f.grant.clone();
    let mut store = true;
    match case {
        "exact" => {}
        "empty-provider" => provider = "",
        "other-provider" => provider = "other",
        "empty-owner" => owner = "",
        "other-owner" => owner = "user:other",
        "grant-organization" => grant.organization_id = OrganizationId::new(),
        "grant-connection-absent" => grant.connection_id = None,
        "grant-connection-other" => grant.connection_id = Some(ConnectionId::new()),
        "child-grant" => grant.parent_grant_id = Some(GrantId::new()),
        "delegation-depth" => grant.delegation_depth = 1,
        "expired-grant" => grant.constraints.expires_at = Utc::now() - Duration::hours(1),
        "revoked-grant" => grant.revoked_at = Some(Utc::now()),
        "stored-grant-differs" => {
            grant.actions.push("vector.other".into());
            store = false;
        }
        "stored-grant-missing" => {
            grant.id = GrantId::new();
            store = false;
        }
        "row-revoked" | "row-needs-reauth" => {
            let status = if case == "row-revoked" {
                "revoked"
            } else {
                "needs_reauth"
            };
            let id = f.connection.clone();
            sql(
                &f,
                "UPDATE connections SET status = ? WHERE id = ?",
                status,
                &id,
            )
            .await;
        }
        "url-outside-egress" => url = "https://outside.invalid/effect".into(),
        _ => panic!("vector: unknown case: {line}"),
    }
    if store {
        store_grant(&f, &grant).await;
    }
    f.grant = grant;
    let expectation = || crate::egress::OwnerConnectionExpectation {
        organization_id: &f.organization,
        connection_id: &f.connection,
        provider_id: provider,
        owner_subject: owner,
        grant: &f.grant,
    };
    let result = match api {
        "json" => f
            .broker
            .authorized_json_for_owner(expectation(), "GET", &url, None)
            .await
            .map(drop),
        "http" => f
            .broker
            .authorized_http_for_owner(expectation(), "GET", &url, None)
            .await
            .map(drop),
        _ => panic!("vector: unknown api: {line}"),
    };
    let actual = match &result {
        Ok(()) => "sent",
        Err(BrokerError::ConnectionNotFound) => "not-found",
        Err(BrokerError::NeedsReauth(_)) => "needs-reauth",
        Err(BrokerError::Invalid(message)) if message.contains("revoked") => "revoked",
        Err(BrokerError::Invalid(_)) => "refused",
        Err(other) => panic!("vector: {line}: unexpected error {other}"),
    };
    assert_eq!(actual, expected, "vector: {line}: {result:?}");
    let sent = usize::from(expected == "sent");
    assert_eq!(
        f.effects.load(Ordering::SeqCst),
        sent,
        "vector: {line}: effects"
    );
}

#[tokio::test]
#[ignore = "run by spec/formal/invocation/verify.sh with Lean vectors"]
async fn lean_owner_egress_vectors_match_the_broker() {
    let path = std::env::var("OPENSESAME_INVOCATION_EFFECT_VECTORS").expect("Lean vector file");
    let mut count = 0;
    for line in std::fs::read_to_string(path).unwrap().lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        if fields[0] != "d2" {
            continue;
        }
        let [_, api, case, expected] = fields[..] else {
            panic!("vector: invalid: {line}")
        };
        replay(line, api, case, expected).await;
        count += 1;
    }
    assert!(count > 0, "no d2 vectors");
    println!("invocation-formal: {count} d2 vectors matched");
}
