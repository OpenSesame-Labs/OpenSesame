use super::*;
use crate::app_state::{test_demo_state, test_session_headers};
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use opensesame_connection_broker::{
    BrokerConfig, ConnectionBroker, CreateConnection, CreateIntegration,
};
use opensesame_domain::{OrganizationRole, Shareability};
use std::sync::Arc;
use tower::ServiceExt;

fn app(state: AppState) -> Router {
    crate::routes::router(state)
}

fn operator(st: &AppState) -> String {
    st.operator_token.clone()
}

/// A state whose broker is backed by the same pool, so connections created
/// here are the ones the routes resolve.
async fn state_with_broker() -> AppState {
    let mut st = test_demo_state().await;
    st.connection_broker = Arc::new(
        ConnectionBroker::new(
            st.db.pool().clone(),
            BrokerConfig::in_memory(Some([42u8; 32]), "http://127.0.0.1:8787"),
        )
        .unwrap(),
    );
    st
}

async fn make_connection(st: &AppState, provider_id: &str) -> String {
    let org = st.connection_organization;
    // Dropbox authenticates with OAuth, so a connection needs an
    // integration to hang off; API-key providers do not.
    let integration_id = if provider_id == "dropbox" {
        Some(
            st.connection_broker
                .create_integration(
                    &org,
                    CreateIntegration {
                        key: format!("{provider_id}-attachments"),
                        provider_id: provider_id.into(),
                        display_name: "Attachments".into(),
                        scopes: vec!["files.content.write".into()],
                        client_id: Some("client".into()),
                        client_secret: Some("secret".into()),
                        configuration: std::collections::BTreeMap::default(),
                        created_by: "principal:attach-tester".into(),
                    },
                )
                .await
                .unwrap()
                .id,
        )
    } else {
        None
    };
    st.connection_broker
        .create_connection(
            &org,
            CreateConnection {
                provider_id: provider_id.into(),
                integration_id,
                owner_subject: Some(crate::test_principals::P26.into()),
                display_name: Some(provider_id.into()),
                logical_name: None,
                project_id: None,
                scopes: None,
                shareability: Some(Shareability::Private),
            },
        )
        .await
        .unwrap()
        .connection_id
}

fn put_target_req(token: &str, body: &serde_json::Value) -> Request<Body> {
    Request::builder()
        .method("PUT")
        .uri("/api/v1/attachments/target")
        .header("content-type", "application/json")
        .header("x-opensesame-operator", token)
        .body(Body::from(body.to_string()))
        .unwrap()
}

async fn body_json(res: axum::response::Response) -> serde_json::Value {
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
}

#[tokio::test]
async fn target_round_trips_and_delete_clears_it() {
    let st = state_with_broker().await;
    let token = operator(&st);
    let connection = make_connection(&st, "dropbox").await;
    let app = app(st.clone());

    let res = app
        .clone()
        .oneshot(put_target_req(
            &token,
            &json!({
                "connection_id": connection,
                "folder_path": "/OpenSesame/attachments"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/attachments/target")
                .header("x-opensesame-operator", &token)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let got = body_json(res).await;
    assert_eq!(got["target"]["folder_path"], "/OpenSesame/attachments");
    assert_eq!(got["target"]["provider_id"], "dropbox");
    assert_eq!(got["target"]["enabled"], true);
    assert_eq!(
        got["target"]["replication_version"].as_str().unwrap().len(),
        64
    );

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/api/v1/attachments/target")
                .header("x-opensesame-operator", &token)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let res = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/attachments/target")
                .header("x-opensesame-operator", &token)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(body_json(res).await["target"].is_null());
}

#[tokio::test]
async fn a_provider_with_no_uploader_is_refused_at_configuration_time() {
    // Failing here rather than on the first replicate call is the whole
    // point: the operator learns immediately, not after a partial sync.
    let st = state_with_broker().await;
    let token = operator(&st);
    let connection = make_connection(&st, "vercel").await;
    let res = app(st)
        .oneshot(put_target_req(
            &token,
            &json!({"connection_id": connection, "folder_path": "/x"}),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        body_json(res).await["error"],
        "provider_unsupported_for_attachments"
    );
}

#[tokio::test]
async fn a_traversing_folder_path_is_refused() {
    let st = state_with_broker().await;
    let token = operator(&st);
    let connection = make_connection(&st, "dropbox").await;
    let app = app(st);
    for bad in ["/has/../traversal", "relative", "", "/trailing/"] {
        let res = app
            .clone()
            .oneshot(put_target_req(
                &token,
                &json!({"connection_id": connection, "folder_path": bad}),
            ))
            .await
            .unwrap();
        assert_eq!(
            res.status(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "folder_path {bad:?} must be refused"
        );
    }
}

#[tokio::test]
async fn an_unknown_connection_cannot_be_configured() {
    let st = state_with_broker().await;
    let token = operator(&st);
    let res = app(st)
        .oneshot(put_target_req(
            &token,
            &json!({"connection_id": "connection:nope", "folder_path": "/x"}),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body_json(res).await["error"], "connection_not_found");
}

#[tokio::test]
async fn target_routes_are_operator_gated() {
    let st = state_with_broker().await;
    let app = app(st);
    let res = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/attachments/target")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_ne!(
        res.status(),
        StatusCode::OK,
        "must not answer unauthenticated"
    );
}

#[path = "attachments_authority_tests.rs"]
mod authority;
#[path = "attachments_upload_tests.rs"]
mod uploads;
