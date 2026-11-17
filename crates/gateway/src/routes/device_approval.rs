//! Validation and atomic publication of an operator-approved device grant.
use super::*;
use sqlx::Row;

pub(super) fn membership_revision(
    req: &DeviceApproveRequest,
) -> Result<Option<crate::session_claims::MembershipRevision>, ()> {
    let local = req.organization_id.is_none() && req.organization_role.is_none();
    match (&req.membership_incarnation, &req.authority_revision, local) {
        (None, None, true) => Ok(None),
        (Some(incarnation), Some(revision), false)
            if [incarnation, revision].iter().all(|value| {
                uuid::Uuid::parse_str(value)
                    .is_ok_and(|id| !id.is_nil() && id.to_string() == value.as_str())
            }) =>
        {
            Ok(Some(crate::session_claims::MembershipRevision {
                incarnation: incarnation.clone(),
                revision: revision.clone(),
            }))
        }
        _ => Err(()),
    }
}

pub(super) async fn approve_native(
    st: &AppState,
    headers: &axum::http::HeaderMap,
    req: &DeviceApproveRequest,
    revision: Option<crate::session_claims::MembershipRevision>,
) -> Response {
    if let Err(resp) = require_operator(st, headers) {
        return resp;
    }
    match attempt(st, req, revision).await {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!(%error, "device approval store unavailable");
            StatusCode::SERVICE_UNAVAILABLE.into_response()
        }
    }
}

async fn attempt(
    st: &AppState,
    req: &DeviceApproveRequest,
    revision: Option<crate::session_claims::MembershipRevision>,
) -> anyhow::Result<Response> {
    // The shared write transaction bounds guesses across replicas and makes
    // approval, membership fencing, and native role publication indivisible.
    let mut tx = st.db.pool().begin_with("BEGIN IMMEDIATE").await?;
    let now = Utc::now().timestamp_millis();
    sqlx::query("DELETE FROM host_device_approval_failures WHERE attempted_at <= ?")
        .bind(now - APPROVE_FAILURE_WINDOW_SECS * 1000)
        .execute(&mut *tx)
        .await?;
    let failures: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM host_device_approval_failures")
        .fetch_one(&mut *tx)
        .await?;
    if failures >= MAX_APPROVE_FAILURES as i64 {
        tx.commit().await?;
        return Ok((
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({
                "error":"too_many_attempts", "retry_after_seconds":APPROVE_FAILURE_WINDOW_SECS,
            })),
        )
            .into_response());
    }
    sqlx::query("DELETE FROM host_device_codes WHERE expires_at <= ?")
        .bind(now)
        .execute(&mut *tx)
        .await?;
    let rows =
        sqlx::query("SELECT device_digest,user_code_hash,client_id,scope FROM host_device_codes")
            .fetch_all(&mut *tx)
            .await?;
    for row in rows {
        let digest: String = row.try_get("device_digest")?;
        let stored: String = row.try_get("user_code_hash")?;
        if !hash_eq(
            &user_code_digest(&st.claim_pepper, &digest, &req.user_code),
            &stored,
        ) {
            continue;
        }
        let operator_default = if req.organization_id.is_none() && req.organization_role.is_none() {
            match require_demo_bootstrap(st) {
                Ok(boot) => Some(boot.org),
                Err(resp) => return Ok(resp),
            }
        } else {
            None
        };
        let (organization, role) = match approved_organization(
            req.organization_id.as_deref(),
            req.organization_role,
            operator_default,
        ) {
            Ok(organization) => organization,
            Err(error) => {
                return Ok((StatusCode::BAD_REQUEST, Json(json!({"error":error}))).into_response())
            }
        };
        let Some(principal) = req
            .principal
            .as_deref()
            .and_then(crate::session_claims::parse_principal)
        else {
            return Ok((
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"principal_required"})),
            )
                .into_response());
        };
        if let Some(value) = revision.as_ref() {
            if !crate::native_authority::revision_live(
                &mut tx,
                &organization.to_string(),
                &principal.to_string(),
                Some(value),
            )
            .await?
            {
                return Ok((
                    StatusCode::CONFLICT,
                    Json(json!({"error":"membership_withdrawn"})),
                )
                    .into_response());
            }
        }
        opensesame_connection_broker::config_access::provision_native_role_in_transaction(
            &mut tx,
            &organization,
            &principal,
            role,
        )
        .await?;
        if let Some(value) = revision.as_ref() {
            sqlx::query("INSERT INTO host_membership_current
                (organization_id,principal_id,membership_incarnation,authority_revision) VALUES (?,?,?,?)
                ON CONFLICT(organization_id,principal_id) DO UPDATE SET
                  membership_incarnation=excluded.membership_incarnation,authority_revision=excluded.authority_revision")
                .bind(organization.to_string()).bind(principal.to_string())
                .bind(&value.incarnation).bind(&value.revision).execute(&mut *tx).await?;
        }
        let approval = ApprovedDevice {
            principal: principal.to_string(),
            organization_id: organization,
            organization_role: role,
            membership_revision: revision.clone(),
        };
        sqlx::query("UPDATE host_device_codes SET approved_json=?,organization_id=?,principal_id=?,membership_incarnation=?,authority_revision=? WHERE device_digest=?")
            .bind(serde_json::to_string(&approval)?).bind(organization.to_string()).bind(principal.to_string())
            .bind(revision.as_ref().map(|value| value.incarnation.as_str()))
            .bind(revision.as_ref().map(|value| value.revision.as_str()))
            .bind(digest).execute(&mut *tx).await?;
        let client_id: String = row.try_get("client_id")?;
        let scope: String = row.try_get("scope")?;
        tx.commit().await?;
        return Ok((
            StatusCode::OK,
            Json(json!({"status":"approved","client_id":client_id,"scope":scope})),
        )
            .into_response());
    }
    // A failed guess spends budget but does not cancel any pending grant.
    sqlx::query("INSERT INTO host_device_approval_failures(attempted_at) VALUES (?)")
        .bind(now)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok((
        StatusCode::NOT_FOUND,
        Json(json!({"error":"unknown_user_code"})),
    )
        .into_response())
}
