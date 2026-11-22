use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_domain::OrganizationId;
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::{require_operator, require_session};
use crate::session_claims::ATTACHMENT_REPLICATE_CAPABILITY;

pub(super) fn require_replication_authority(
    state: &AppState,
    headers: &axum::http::HeaderMap,
) -> Result<OrganizationId, Response> {
    if let Ok((_, claims)) = require_session(state, headers) {
        let granted = claims
            .capability_ceiling
            .iter()
            .any(|capability| capability == ATTACHMENT_REPLICATE_CAPABILITY);
        if claims.organization_role.can_configure_integrations() && granted {
            return Ok(claims.organization_id);
        }
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "forbidden",
                "hint": "attachment replication requires an administrator session with sealed_store.attach.replicate",
            })),
        )
            .into_response());
    }
    require_operator(state, headers)?;
    Ok(state.connection_organization)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_state::test_demo_state;
    use axum::{body::Body, http::Request, Router};
    use opensesame_domain::OrganizationRole;
    use tower::ServiceExt;

    fn app(state: AppState) -> Router {
        crate::routes::router(state)
    }

    fn replication_session(
        state: &AppState,
        role: OrganizationRole,
        capabilities: &[&str],
    ) -> String {
        let raw = format!("fixture_{}", uuid::Uuid::new_v4());
        let mut claims = crate::session_claims::fixture(
            opensesame_domain::PrincipalId::new(),
            state.connection_organization,
            role,
            &state.resource,
        );
        claims.capability_ceiling = capabilities
            .iter()
            .map(|capability| (*capability).to_owned())
            .collect();
        state
            .sessions
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

    async fn body_json(response: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
    }

    #[tokio::test]
    async fn replication_requires_both_admin_role_and_exact_operation_grant() {
        let state = test_demo_state().await;
        let app = app(state.clone());
        let member_with_grant = replication_session(
            &state,
            OrganizationRole::Member,
            &[ATTACHMENT_REPLICATE_CAPABILITY],
        );
        let response = app
            .clone()
            .oneshot(replicate_manifest_req(&member_with_grant))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        let owner_without_grant =
            replication_session(&state, OrganizationRole::Owner, &["host:user"]);
        let response = app
            .clone()
            .oneshot(replicate_manifest_req(&owner_without_grant))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        let owner_with_grant = replication_session(
            &state,
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
        let state = test_demo_state().await;
        let member_with_grant = replication_session(
            &state,
            OrganizationRole::Member,
            &[ATTACHMENT_REPLICATE_CAPABILITY],
        );
        let response = app(state)
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
}
