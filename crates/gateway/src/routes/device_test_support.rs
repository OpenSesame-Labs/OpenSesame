use super::*;

pub(super) const TEST_PEPPER: &str = "test-pepper";

pub(super) fn pending(device_digest: &str, user_code: &str) -> DevicePending {
    DevicePending {
        user_code_hash: user_code_digest(TEST_PEPPER, device_digest, user_code),
        client_id: "opensesame-cli".into(),
        scope: DEVICE_SCOPE.into(),
        expires_at: Utc::now() + Duration::minutes(15),
        approved: None,
    }
}

pub(super) async fn insert_pending(state: &AppState, digest: &str, pending: DevicePending) {
    let approved = pending.approved.as_ref();
    sqlx::query("INSERT INTO host_device_codes(device_digest,user_code_hash,client_id,scope,expires_at,approved_json,organization_id,principal_id,membership_incarnation,authority_revision) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .bind(digest).bind(&pending.user_code_hash).bind(&pending.client_id).bind(&pending.scope)
        .bind(pending.expires_at.timestamp_millis())
        .bind(approved.map(|value| serde_json::to_string(value).unwrap()))
        .bind(approved.map(|value| value.organization_id.to_string()))
        .bind(approved.map(|value| value.principal.clone()))
        .bind(approved.and_then(|value| value.membership_revision.as_ref()).map(|value| value.incarnation.as_str()))
        .bind(approved.and_then(|value| value.membership_revision.as_ref()).map(|value| value.revision.as_str()))
        .execute(state.db.pool()).await.unwrap();
}

pub(super) async fn pending_count(state: &AppState) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM host_device_codes")
        .fetch_one(state.db.pool())
        .await
        .unwrap()
}

pub(super) async fn mint_approved(
    state: &AppState,
    device_code: &str,
    principal: String,
    organization_id: opensesame_domain::OrganizationId,
) -> serde_json::Value {
    insert_pending(
        state,
        &hash_secret(device_code),
        DevicePending {
            user_code_hash: "digest".into(),
            client_id: "opensesame-cli".into(),
            scope: DEVICE_SCOPE.into(),
            expires_at: Utc::now() + Duration::minutes(5),
            approved: Some(ApprovedDevice {
                principal,
                organization_id,
                organization_role: opensesame_domain::OrganizationRole::Member,
                membership_revision: None,
            }),
        },
    )
    .await;
    let response = token(
        State(state.clone()),
        Json(DeviceTokenRequest {
            device_code: device_code.into(),
            client_id: "opensesame-cli".into(),
            grant_type: "urn:ietf:params:oauth:grant-type:device_code".into(),
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&body).unwrap()
}

pub(super) fn spawn_authorize(state: AppState) -> tokio::task::JoinHandle<StatusCode> {
    tokio::spawn(async move {
        authorize(
            State(state),
            Json(DeviceAuthorizeRequest {
                client_id: "opensesame-cli".into(),
                scope: None,
            }),
        )
        .await
        .into_response()
        .status()
    })
}

pub(super) fn spawn_failed_approve(
    state: AppState,
    headers: axum::http::HeaderMap,
) -> tokio::task::JoinHandle<StatusCode> {
    tokio::spawn(async move {
        approve(
            State(state),
            headers,
            Json(DeviceApproveRequest {
                user_code: "XXXX-YYYY".into(),
                principal: None,
                organization_id: None,
                organization_role: None,
                membership_incarnation: None,
                authority_revision: None,
            }),
        )
        .await
        .into_response()
        .status()
    })
}
