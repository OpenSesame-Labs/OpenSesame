//! Enforce durable Identity membership withdrawal fences on every request.
use crate::{app_state::AppState, middleware::auth::require_session};
use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};

pub async fn guard(State(st): State<AppState>, request: Request, next: Next) -> Response {
    if let Ok((digest, claims)) = require_session(&st, request.headers()) {
        if let Some(revision) = claims.membership_revision.as_ref() {
            let live = st
                .db
                .host_membership_live(
                    &claims.organization_id.to_string(),
                    &claims.principal_id.to_string(),
                    &revision.incarnation,
                    &revision.revision,
                )
                .await
                .unwrap_or(false);
            if !live {
                st.sessions.lock().unwrap().remove(&digest);
                return StatusCode::UNAUTHORIZED.into_response();
            }
        }
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };
    use tower::ServiceExt;

    #[tokio::test]
    async fn withdrawal_on_one_replica_fences_a_session_on_another() {
        let directory = tempfile::tempdir().unwrap();
        let url = opensesame_storage::sqlite_file_url(&directory.path().join("host.sqlite"));
        let mut first = crate::app_state::test_demo_state().await;
        first.db = opensesame_storage::Db::connect_sqlite(&url).await.unwrap();
        let mut second = first.clone();
        second.db = opensesame_storage::Db::connect_sqlite(&url).await.unwrap();
        second.sessions = Arc::new(Mutex::new(HashMap::new()));

        let principal = opensesame_domain::PrincipalId::new();
        let organization = opensesame_domain::OrganizationId::new();
        let revision = crate::session_claims::MembershipRevision {
            incarnation: uuid::Uuid::new_v4().to_string(),
            revision: uuid::Uuid::new_v4().to_string(),
        };
        let raw = "replica-session";
        let digest = opensesame_claims::hash_secret(raw);
        let mut claims = crate::session_claims::fixture(
            principal,
            organization,
            opensesame_domain::OrganizationRole::Member,
            &first.resource,
        );
        claims.membership_revision = Some(revision.clone());
        first.sessions.lock().unwrap().insert(digest, claims);

        let withdrawal_id = uuid::Uuid::new_v4().to_string();
        let organization_id = organization.to_string();
        let principal_id = principal.to_string();
        second
            .db
            .withdraw_host_membership(&opensesame_storage::host_membership::MembershipWithdrawal {
                withdrawal_id: &withdrawal_id,
                organization_id: &organization_id,
                principal_id: &principal_id,
                membership_incarnation: &revision.incarnation,
                authority_revision: &revision.revision,
            })
            .await
            .unwrap();

        let request = Request::builder()
            .uri("/api/v1/whoami")
            .header("authorization", format!("Bearer opaque-session:{raw}"))
            .body(Body::empty())
            .unwrap();
        let response = crate::routes::router(first).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
}
