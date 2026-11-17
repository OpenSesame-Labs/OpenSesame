use super::*;
use crate::app_state::test_demo_state;
use axum::{body::Body, http::{header, Request}, Json};
use opensesame_domain::{OrganizationId, PrincipalId};
use std::{collections::HashMap, sync::{Arc, Mutex}};
use tower::ServiceExt;

fn operator(st: &AppState) -> axum::http::HeaderMap {
    let mut headers = axum::http::HeaderMap::new();
    headers.insert("x-opensesame-operator", st.operator_token.parse().unwrap());
    headers
}

async fn response_json(response: Response) -> serde_json::Value {
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&body).unwrap()
}

async fn revoke(st: &AppState, principal: &str, org: &str, inc: &str, rev: &str, id: &str) -> Response {
    let input = serde_json::from_value(json!({"principal_id":principal,"organization_id":org,
        "membership_incarnation":inc,"authority_revision":rev,"withdrawal_id":id})).unwrap();
    super::super::session::revoke(State(st.clone()), operator(st), Json(input)).await
}

#[tokio::test]
async fn replica_withdrawal_blocks_late_approval_and_old_device_redemption() {
    let first = test_demo_state().await;
    let mut second = first.clone();
    second.sessions = Arc::new(Mutex::new(HashMap::new()));
    second.device_codes = Arc::new(Mutex::new(HashMap::new()));
    second.session_lifecycle = Arc::new(tokio::sync::Mutex::new(()));
    let principal = PrincipalId::new().to_string();
    let org = OrganizationId::new().to_string();
    let inc = uuid::Uuid::new_v4().to_string();
    let old = uuid::Uuid::new_v4().to_string();
    let new = uuid::Uuid::new_v4().to_string();
    let withdrawal = uuid::Uuid::new_v4().to_string();
    let new_withdrawal = uuid::Uuid::new_v4().to_string();
    let result = authorize(State(first.clone()), Json(DeviceAuthorizeRequest {
        client_id: "opensesame-cli".into(), scope: None,
    })).await.into_response();
    let issued = response_json(result).await;
    let code = issued["user_code"].as_str().unwrap();
    let device = issued["device_code"].as_str().unwrap();
    let approval = |revision: &str| DeviceApproveRequest {
        user_code: code.into(), principal: Some(principal.clone()), organization_id: Some(org.clone()),
        organization_role: Some(opensesame_domain::OrganizationRole::Member),
        membership_incarnation: Some(inc.clone()), authority_revision: Some(revision.into()),
    };
    assert_eq!(approve(State(first.clone()), operator(&first), Json(approval(&old))).await.status(), StatusCode::OK);
    assert_eq!(revoke(&second, &principal, &org, &inc, &old, &withdrawal).await.status(), StatusCode::OK);
    assert_eq!(approve(State(first.clone()), operator(&first), Json(approval(&old))).await.status(), StatusCode::CONFLICT);
    let token_request = || DeviceTokenRequest { device_code: device.into(), client_id: "opensesame-cli".into(),
        grant_type: "urn:ietf:params:oauth:grant-type:device_code".into() };
    assert_eq!(token(State(first.clone()), Json(token_request())).await.status(), StatusCode::BAD_REQUEST);
    assert_eq!(approve(State(first.clone()), operator(&first), Json(approval(&new))).await.status(), StatusCode::OK);
    let minted = response_json(token(State(first.clone()), Json(token_request())).await).await;
    assert_eq!(minted["session"]["authority_revision"], new);
    let bearer = format!("Bearer {}", minted["access_token"].as_str().unwrap());
    let request = || Request::builder().uri("/api/v1/whoami").header(header::AUTHORIZATION, &bearer).body(Body::empty()).unwrap();
    assert_eq!(revoke(&second, &principal, &org, &inc, &old, &withdrawal).await.status(), StatusCode::OK);
    assert_eq!(crate::routes::router(first.clone()).oneshot(request()).await.unwrap().status(), StatusCode::OK);
    assert_eq!(revoke(&second, &principal, &org, &inc, &new, &new_withdrawal).await.status(), StatusCode::OK);
    assert_eq!(crate::routes::router(first.clone()).oneshot(request()).await.unwrap().status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn remote_untagged_approval_is_rejected_while_local_bootstrap_is_kept() {
    let st = test_demo_state().await;
    let issued = response_json(authorize(State(st.clone()), Json(DeviceAuthorizeRequest {
        client_id: "opensesame-cli".into(), scope: None,
    })).await.into_response()).await;
    let principal = st.bootstrap.lock().unwrap().as_ref().unwrap().principal.to_string();
    let code = issued["user_code"].as_str().unwrap().to_owned();
    let remote = DeviceApproveRequest { user_code: code.clone(), principal: Some(principal.clone()),
        organization_id: Some(OrganizationId::new().to_string()), organization_role: Some(opensesame_domain::OrganizationRole::Member),
        membership_incarnation: None, authority_revision: None };
    assert_eq!(approve(State(st.clone()), operator(&st), Json(remote)).await.status(), StatusCode::BAD_REQUEST);
    let local = DeviceApproveRequest { user_code: code, principal: Some(principal), organization_id: None,
        organization_role: None, membership_incarnation: None, authority_revision: None };
    assert_eq!(approve(State(st.clone()), operator(&st), Json(local)).await.status(), StatusCode::OK);
}
