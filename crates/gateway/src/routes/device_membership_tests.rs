use super::*;
use crate::app_state::test_demo_state;
use axum::{
    body::Body,
    http::{header, Request},
    Json,
};
use opensesame_domain::{OrganizationId, PrincipalId};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tower::ServiceExt;

fn operator(st: &AppState) -> axum::http::HeaderMap {
    let mut headers = axum::http::HeaderMap::new();
    headers.insert("x-opensesame-operator", st.operator_token.parse().unwrap());
    headers
}

async fn response_json(response: Response) -> serde_json::Value {
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&body).unwrap()
}

async fn revoke(
    st: &AppState,
    principal: &str,
    org: &str,
    inc: &str,
    rev: &str,
    id: &str,
) -> Response {
    let input = serde_json::from_value(json!({"principal_id":principal,"organization_id":org,
        "membership_incarnation":inc,"authority_revision":rev,"withdrawal_id":id}))
    .unwrap();
    super::super::session::revoke(State(st.clone()), operator(st), Json(input)).await
}

#[tokio::test]
async fn replica_withdrawal_blocks_late_approval_and_old_device_redemption() {
    let first = test_demo_state().await;
    let mut second = first.clone();
    second.sessions = Arc::new(Mutex::new(HashMap::new()));
    let principal = PrincipalId::new().to_string();
    let org = OrganizationId::new().to_string();
    let inc = uuid::Uuid::new_v4().to_string();
    let old = uuid::Uuid::new_v4().to_string();
    let new = uuid::Uuid::new_v4().to_string();
    let withdrawal = uuid::Uuid::new_v4().to_string();
    let new_withdrawal = uuid::Uuid::new_v4().to_string();
    let result = authorize(
        State(first.clone()),
        Json(DeviceAuthorizeRequest {
            client_id: "opensesame-cli".into(),
            scope: None,
        }),
    )
    .await
    .into_response();
    let issued = response_json(result).await;
    let code = issued["user_code"].as_str().unwrap();
    let device = issued["device_code"].as_str().unwrap();
    let approval = |revision: &str| DeviceApproveRequest {
        user_code: code.into(),
        principal: Some(principal.clone()),
        organization_id: Some(org.clone()),
        organization_role: Some(opensesame_domain::OrganizationRole::Member),
        membership_incarnation: Some(inc.clone()),
        authority_revision: Some(revision.into()),
    };
    assert_eq!(
        approve_membership(
            State(first.clone()),
            operator(&first),
            Json(approval(&old)),
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        revoke(&second, &principal, &org, &inc, &old, &withdrawal)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        approve_membership(
            State(first.clone()),
            operator(&first),
            Json(approval(&old)),
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    let token_request = || DeviceTokenRequest {
        device_code: device.into(),
        client_id: "opensesame-cli".into(),
        grant_type: "urn:ietf:params:oauth:grant-type:device_code".into(),
    };
    assert_eq!(
        token(State(first.clone()), Json(token_request()))
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        approve_membership(
            State(first.clone()),
            operator(&first),
            Json(approval(&new)),
        )
        .await
        .status(),
        StatusCode::OK
    );
    let minted = response_json(token(State(first.clone()), Json(token_request())).await).await;
    assert_eq!(minted["session"]["authority_revision"], new);
    let bearer = format!("Bearer {}", minted["access_token"].as_str().unwrap());
    let request = || {
        Request::builder()
            .uri("/api/v1/whoami")
            .header(header::AUTHORIZATION, &bearer)
            .body(Body::empty())
            .unwrap()
    };
    assert_eq!(
        revoke(&second, &principal, &org, &inc, &old, &withdrawal)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        crate::routes::router(first.clone())
            .oneshot(request())
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        revoke(&second, &principal, &org, &inc, &new, &new_withdrawal)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        crate::routes::router(first.clone())
            .oneshot(request())
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn remote_untagged_approval_is_rejected_while_local_bootstrap_is_kept() {
    let st = test_demo_state().await;
    let issued = response_json(
        authorize(
            State(st.clone()),
            Json(DeviceAuthorizeRequest {
                client_id: "opensesame-cli".into(),
                scope: None,
            }),
        )
        .await
        .into_response(),
    )
    .await;
    let principal = st
        .bootstrap
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .principal
        .to_string();
    let code = issued["user_code"].as_str().unwrap().to_owned();
    let remote = || DeviceApproveRequest {
        user_code: code.clone(),
        principal: Some(principal.clone()),
        organization_id: Some(OrganizationId::new().to_string()),
        organization_role: Some(opensesame_domain::OrganizationRole::Member),
        membership_incarnation: None,
        authority_revision: None,
    };
    assert_eq!(
        approve(State(st.clone()), operator(&st), Json(remote()))
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        approve_membership(State(st.clone()), operator(&st), Json(remote()))
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    let local = || DeviceApproveRequest {
        user_code: code.clone(),
        principal: Some(principal.clone()),
        organization_id: None,
        organization_role: None,
        membership_incarnation: None,
        authority_revision: None,
    };
    assert_eq!(
        approve_membership(State(st.clone()), operator(&st), Json(local()))
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        approve(State(st.clone()), operator(&st), Json(local()))
            .await
            .status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn legacy_revision_withdrawal_is_scoped_to_one_principal_and_organization() {
    const INCARNATION: &str = "00000000-0000-4000-8000-000000000001";
    const REVISION: &str = "00000000-0000-4000-8000-000000000002";
    let state = test_demo_state().await;
    let router = crate::routes::router(state.clone());
    let p1 = PrincipalId::new().to_string();
    let p2 = PrincipalId::new().to_string();
    let o1 = OrganizationId::new().to_string();
    let o2 = OrganizationId::new().to_string();

    async fn post(
        router: &axum::Router,
        state: &AppState,
        path: &str,
        value: serde_json::Value,
        operator: bool,
    ) -> Response {
        let mut request = Request::builder()
            .method("POST")
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json");
        if operator {
            request = request.header("x-opensesame-operator", &state.operator_token);
        }
        router
            .clone()
            .oneshot(request.body(Body::from(value.to_string())).unwrap())
            .await
            .unwrap()
    }

    let mut tokens = Vec::new();
    for (principal, organization) in [(&p1, &o1), (&p2, &o1), (&p1, &o2)] {
        let issued = post(
            &router,
            &state,
            "/api/v1/device/authorize",
            json!({"client_id":"opensesame-cli"}),
            false,
        )
        .await;
        assert_eq!(issued.status(), StatusCode::OK);
        let issued = response_json(issued).await;
        let without_revision = json!({
            "user_code": issued["user_code"], "principal": principal,
            "organization_id": organization, "organization_role":"member"
        });
        for (with_operator, expected) in [
            (false, StatusCode::UNAUTHORIZED),
            (true, StatusCode::BAD_REQUEST),
        ] {
            let refused = post(
                &router,
                &state,
                "/api/v1/device/approve-membership",
                without_revision.clone(),
                with_operator,
            )
            .await;
            assert_eq!(refused.status(), expected);
        }
        let approved = post(&router, &state, "/api/v1/device/approve-membership", json!({
            "user_code": issued["user_code"], "principal": principal, "organization_id": organization,
            "organization_role":"member", "membership_incarnation":INCARNATION, "authority_revision":REVISION
        }), true).await;
        assert_eq!(approved.status(), StatusCode::OK);
        let token = post(
            &router,
            &state,
            "/api/v1/device/token",
            json!({
                "device_code": issued["device_code"], "client_id":"opensesame-cli",
                "grant_type":"urn:ietf:params:oauth:grant-type:device_code"
            }),
            false,
        )
        .await;
        assert_eq!(token.status(), StatusCode::OK);
        tokens.push(
            response_json(token).await["access_token"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
    }
    let withdrawal = post(
        &router,
        &state,
        "/api/v1/sessions/revoke",
        json!({
            "principal_id":p1, "organization_id":o1, "membership_incarnation":INCARNATION,
            "authority_revision":REVISION, "withdrawal_id":uuid::Uuid::new_v4().to_string()
        }),
        true,
    )
    .await;
    assert_eq!(withdrawal.status(), StatusCode::OK);
    for (index, token) in tokens.iter().enumerate() {
        let request = Request::builder()
            .uri("/api/v1/whoami")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        assert_eq!(
            response.status(),
            if index == 0 {
                StatusCode::UNAUTHORIZED
            } else {
                StatusCode::OK
            }
        );
    }
    let issued = response_json(
        post(
            &router,
            &state,
            "/api/v1/device/authorize",
            json!({"client_id":"opensesame-cli"}),
            false,
        )
        .await,
    )
    .await;
    let stale = post(&router, &state, "/api/v1/device/approve-membership", json!({
        "user_code":issued["user_code"], "principal":p1, "organization_id":o1, "organization_role":"member",
        "membership_incarnation":INCARNATION, "authority_revision":REVISION
    }), true).await;
    assert_eq!(stale.status(), StatusCode::CONFLICT);
}
