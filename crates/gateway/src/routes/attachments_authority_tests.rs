use super::*;
use crate::app_state::test_demo_state;
use axum::{body::Body, http::Request, Router};
use opensesame_domain::OrganizationRole;
use tower::ServiceExt;

fn app(state: AppState) -> Router {
    crate::routes::router(state)
}

fn replication_session(st: &AppState, role: OrganizationRole, capabilities: &[&str]) -> String {
    let raw = uuid::Uuid::new_v4().to_string();
    let mut claims = crate::session_claims::fixture(
        opensesame_domain::PrincipalId::new(),
        st.connection_organization,
        role,
        &st.resource,
    );
    claims.capability_ceiling = capabilities
        .iter()
        .map(|capability| (*capability).to_owned())
        .collect();
    st.sessions
        .lock()
        .unwrap()
        .insert(opensesame_claims::hash_secret(&raw), claims);
    format!("opaque-session:{raw}")
}

fn replicate_manifest_req(token: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/api/v1/attachments/replicate/manifest?path=Taxes/2025")
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/octet-stream")
        .body(Body::from(b"sealed manifest".to_vec()))
        .unwrap()
}

async fn body_json(res: axum::response::Response) -> serde_json::Value {
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
}

#[tokio::test]
async fn replication_requires_both_admin_role_and_exact_operation_grant() {
    let st = test_demo_state().await;
    let app = app(st.clone());

    let member_with_grant = replication_session(
        &st,
        OrganizationRole::Member,
        &[ATTACHMENT_REPLICATE_CAPABILITY],
    );
    let response = app
        .clone()
        .oneshot(replicate_manifest_req(&member_with_grant))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    let owner_without_grant = replication_session(&st, OrganizationRole::Owner, &["host:user"]);
    let response = app
        .clone()
        .oneshot(replicate_manifest_req(&owner_without_grant))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    let owner_with_grant = replication_session(
        &st,
        OrganizationRole::Owner,
        &["host:user", ATTACHMENT_REPLICATE_CAPABILITY],
    );
    let response = app
        .oneshot(replicate_manifest_req(&owner_with_grant))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body_json(response).await["error"], "no_attachment_target");
}

#[tokio::test]
async fn chunk_replication_checks_authority_before_request_data() {
    let st = test_demo_state().await;
    let member_with_grant = replication_session(
        &st,
        OrganizationRole::Member,
        &[ATTACHMENT_REPLICATE_CAPABILITY],
    );
    let response = app(st)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/attachments/replicate/chunk?digest=not-a-digest")
                .header("authorization", format!("Bearer {member_with_grant}"))
                .header("content-type", "application/octet-stream")
                .body(Body::from(b"ciphertext".to_vec()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}
