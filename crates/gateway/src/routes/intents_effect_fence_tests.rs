//! Delegated execution stays local until effects have a durable authority fence.

use super::*;
use opensesame_connector_host::{Connector, HostError, InvokeRequest, InvokeResult};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

struct EffectConnector(Arc<AtomicUsize>);

impl Connector for EffectConnector {
    fn id(&self) -> &str {
        "effect-test"
    }

    fn version(&self) -> &str {
        "1"
    }

    fn component_digest(&self) -> &str {
        "sha256:effect-test"
    }

    fn operations(&self) -> &[&str] {
        &["repository.read"]
    }

    fn invoke(&self, _request: &InvokeRequest) -> Result<InvokeResult, HostError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(InvokeResult {
            ok: true,
            safe_summary: json!({"result": "completed"}),
            external_request_digest: None,
        })
    }
}

fn install_effectful_connector(state: &mut AppState, effects: &Arc<AtomicUsize>, binding: &str) {
    let broker = Arc::get_mut(&mut state.broker).expect("test state owns its broker");
    broker
        .host
        .policy
        .trusted_digests
        .insert("sha256:effect-test".into());
    broker
        .host
        .register_connector(Arc::new(EffectConnector(Arc::clone(effects))))
        .unwrap();
    broker.host.bind_connection(binding, "effect-test").unwrap();
    broker.host.bind_provider("github", binding).unwrap();
    broker
        .policy
        .relationships
        .write(&format!("connection:{binding}"), "user", OWNER);
}

fn keyed_body(connection: &str, key: &str) -> InvokeBody {
    let mut body = invoke_body(connection, "repository.read");
    body.idempotency_key = Some(key.into());
    body
}

async fn remaining(state: &AppState, delegation: &str) -> i64 {
    let raw: String =
        sqlx::query_scalar("SELECT budget_remaining FROM connection_delegations WHERE id = ?")
            .bind(delegation)
            .fetch_one(state.connection_broker.pool())
            .await
            .unwrap();
    serde_json::from_str::<Value>(&raw).unwrap()["invocations"]
        .as_i64()
        .unwrap()
}

async fn response_body(response: Response) -> Value {
    let bytes = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn effectful_delegate_is_refused_before_budget_but_owner_can_invoke() {
    let mut state = crate::app_state::test_demo_state().await;
    let effects = Arc::new(AtomicUsize::new(0));
    install_effectful_connector(&mut state, &effects, "effect-policy");
    let org = state.bootstrap.lock().unwrap().as_ref().unwrap().org;
    let connection = delegable_github_row(&state, org).await;
    let delegation = delegate_to_guest(&state, org, &connection).await;
    sqlx::query("UPDATE connection_delegations SET budget_remaining = ? WHERE id = ?")
        .bind(r#"{"invocations":1}"#)
        .bind(&delegation[0].id)
        .execute(state.db.pool())
        .await
        .unwrap();
    let guest =
        crate::app_state::test_session_headers(&state, GUEST, org, OrganizationRole::Member);
    let response = create(
        State(state.clone()),
        guest,
        Json(keyed_body(&connection, "blocked-effect")),
    )
    .await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        response_body(response).await,
        json!({"error": "delegated_execution_unavailable"})
    );
    assert_eq!(effects.load(Ordering::SeqCst), 0);
    assert_eq!(remaining(&state, &delegation[0].id).await, 1);
    let claims: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM invocation_budget_claims WHERE organization_id = ?",
    )
    .bind(org.to_string())
    .fetch_one(state.db.pool())
    .await
    .unwrap();
    assert_eq!(claims, 0);

    let owner =
        crate::app_state::test_session_headers(&state, OWNER, org, OrganizationRole::Member);
    let response = create(
        State(state),
        owner,
        Json(keyed_body(&connection, "owner-effect")),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(effects.load(Ordering::SeqCst), 1);
}
