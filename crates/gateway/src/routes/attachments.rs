//! Attachment replication target and replicate endpoints (ADR 0054).
//!
//! The free tier keeps sealed attachments in the git-native store. This is the
//! opt-in external tier: an organization points at a storage connection once,
//! and clients then push sealed bytes through these endpoints, which inject the
//! provider credential and forward.
//!
//! The gateway deliberately never holds attachment chunks and runs no
//! replication actor. It cannot: it has no store key, so every byte crossing
//! these routes is ciphertext it cannot read. That is also why there are no
//! outbox events here — there would be nothing for a consumer to replicate
//! from. Replication is client-driven by construction, not by omission.

use axum::{
    body::Bytes,
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_storage::AttachmentTarget;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest as _, Sha256};

use crate::app_state::AppState;
use crate::middleware::auth::{require_operator, Caller};

/// Largest sealed chunk frame: 1 MiB of plaintext plus AEAD overhead, rounded
/// to the chunk ceiling the store writes. Anything larger did not come from
/// this system.
pub const MAX_CHUNK_BODY: usize = 2_621_440;

/// Manifests are small — a digest list — but scale with chunk count.
pub const MAX_MANIFEST_BODY: usize = 1_048_576;

/// A sealed chunk is 1 MiB of plaintext plus a 48-byte frame. If either limit
/// is ever edited below what the store actually writes, replication would
/// reject the store's own output — so this fails the build, not a test run.
const _: () = assert!(MAX_CHUNK_BODY > 1_048_576 + 48);
const _: () = assert!(MAX_MANIFEST_BODY >= 1_048_576);

/// Providers that can receive attachments declare an `attachment_upload`
/// shape in the catalog (ADR 0065 §6): pure data the gateway renders.
/// Providers without one are refused at configuration time rather than
/// failing later on the first replicate call.
fn upload_shape(
    provider_id: &str,
) -> Option<&'static opensesame_connection_broker::catalog::AttachmentUploadShape> {
    opensesame_connection_broker::catalog::find(provider_id)
        .ok()
        .flatten()
        .and_then(|provider| provider.attachment_upload.as_ref())
}

/// Header placements JSON-encode the path, so any printable ASCII is safe;
/// URL placements get no encoding, so they keep the strict store charset.
fn path_is_printable(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 1024
        && path
            .chars()
            .all(|c| c.is_ascii() && !c.is_ascii_control() && c != '\\')
}

fn path_is_url_safe(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 512
        && path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'))
}

fn require_configurator(
    st: &AppState,
    headers: &axum::http::HeaderMap,
) -> Result<Caller, Response> {
    require_operator(st, headers)?;
    Ok(Caller::Operator)
}

fn target_view(target: &AttachmentTarget) -> serde_json::Value {
    json!({
        "connection_id": target.connection_id,
        "provider_id": target.provider_id,
        "folder_path": target.folder_path,
        "enabled": target.enabled,
        "status": target.status,
        "last_error": target.last_error,
        "updated_at_unix_ms": target.updated_at_unix_ms,
        "replication_version": target_replication_version(target),
    })
}

/// Stable over upload status updates, but changes if any field selecting the
/// credential or destination changes. Length prefixes prevent ambiguity.
fn target_replication_version(target: &AttachmentTarget) -> String {
    let mut hash = Sha256::new();
    hash.update(b"opensesame/attachment-target/v1\0");
    for field in [
        &target.organization_id,
        &target.connection_id,
        &target.provider_id,
        &target.folder_path,
    ] {
        hash.update((field.len() as u64).to_be_bytes());
        hash.update(field.as_bytes());
    }
    hex::encode(hash.finalize())
}

fn internal(error: impl std::fmt::Display) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error":"internal","hint":error.to_string()})),
    )
        .into_response()
}

fn unprocessable(code: &str, hint: &str) -> Response {
    (
        StatusCode::UNPROCESSABLE_ENTITY,
        Json(json!({"error": code, "hint": hint})),
    )
        .into_response()
}

/// A destination folder on the provider: absolute, no traversal, no empty
/// segments. This string is interpolated into an upload path, so it is
/// validated here rather than trusted.
fn valid_folder_path(value: &str) -> bool {
    if value.is_empty() || value.len() > 512 || !value.starts_with('/') || value.ends_with('/') {
        return false;
    }
    if value.contains('\\') || value.chars().any(char::is_control) {
        return false;
    }
    value
        .split('/')
        .skip(1) // leading empty segment from the root slash
        .all(|segment| {
            !segment.is_empty()
                && segment != "."
                && segment != ".."
                && !segment.contains(':')
                && segment.chars().all(|c| !c.is_control())
        })
}

/// A store-logical attachment path such as `Taxes/2025`. Same shape the sealed
/// store enforces locally: relative, no traversal, no empty segments.
fn valid_logical_path(value: &str) -> bool {
    if value.is_empty() || value.len() > 512 || value.starts_with('/') || value.ends_with('/') {
        return false;
    }
    if value.contains('\\') || value.chars().any(char::is_control) {
        return false;
    }
    value.split('/').all(|segment| {
        !segment.is_empty() && segment != "." && segment != ".." && !segment.contains(':')
    })
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

pub async fn get_target(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization = who.organization(st.connection_organization).to_string();
    match st.db.get_attachment_target(&organization).await {
        Ok(target) => (
            StatusCode::OK,
            Json(json!({ "target": target.as_ref().map(target_view) })),
        )
            .into_response(),
        Err(error) => internal(error),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PutAttachmentTargetBody {
    pub connection_id: String,
    pub folder_path: String,
    #[serde(default)]
    pub enabled: Option<bool>,
}

pub async fn put_target(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<PutAttachmentTargetBody>,
) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization = who.organization(st.connection_organization);

    if !valid_folder_path(&body.folder_path) {
        return unprocessable(
            "invalid_folder_path",
            "folder_path must be an absolute provider path such as /OpenSesame/attachments, with no '..' or empty segments",
        );
    }

    // The connection must exist in this organization and be a provider we can
    // actually upload to. Refusing here means a misconfiguration surfaces at
    // configuration time rather than on the first replicate call.
    let connection = match st
        .connection_broker
        .get_connection(&organization, &body.connection_id)
        .await
    {
        Ok(view) => view,
        Err(error) => {
            return unprocessable(
                "connection_not_found",
                &format!("no such connection in this organization: {error}"),
            )
        }
    };
    if upload_shape(&connection.provider_id).is_none() {
        return unprocessable(
            "provider_unsupported_for_attachments",
            &format!(
                "provider {} declares no attachment_upload shape in the catalog",
                connection.provider_id
            ),
        );
    }

    let target = AttachmentTarget {
        organization_id: organization.to_string(),
        connection_id: body.connection_id,
        provider_id: connection.provider_id,
        folder_path: body.folder_path,
        enabled: body.enabled.unwrap_or(true),
        status: "configured".to_string(),
        last_error: None,
        updated_at_unix_ms: opensesame_time::Utc::now().timestamp_millis(),
    };
    if let Err(error) = st.db.upsert_attachment_target(&target).await {
        return internal(error);
    }
    (
        StatusCode::OK,
        Json(json!({ "target": target_view(&target) })),
    )
        .into_response()
}

pub async fn delete_target(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    let who = match require_configurator(&st, &headers) {
        Ok(who) => who,
        Err(resp) => return resp,
    };
    let organization = who.organization(st.connection_organization).to_string();
    match st.db.delete_attachment_target(&organization).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "deleted": true }))).into_response(),
        Err(error) => internal(error),
    }
}

/// The configured target, or a response explaining what to configure.
async fn active_target(st: &AppState, organization: &str) -> Result<AttachmentTarget, Response> {
    let target = match st.db.get_attachment_target(organization).await {
        Ok(Some(target)) => target,
        Ok(None) => {
            return Err(unprocessable(
                "no_attachment_target",
                "configure one with PUT /api/v1/attachments/target before replicating",
            ))
        }
        Err(error) => return Err(internal(error)),
    };
    if !target.enabled {
        return Err(unprocessable(
            "attachment_target_disabled",
            "the configured attachment target is disabled",
        ));
    }
    Ok(target)
}

/// Render (url, headers) for one upload from the provider's declared shape.
fn render_upload(
    shape: &opensesame_connection_broker::catalog::AttachmentUploadShape,
    remote_path: &str,
) -> Option<(String, Vec<(String, String)>)> {
    use opensesame_connection_broker::catalog::PathPlacement;
    let mut headers: Vec<(String, String)> = shape.extra_headers.clone();
    let url = match &shape.path_placement {
        PathPlacement::HeaderJson { header, template } => {
            if !path_is_printable(remote_path) {
                return None;
            }
            // JSON-encode the whole string (quotes included) so no path
            // character can break out of the template's value position.
            let encoded = serde_json::to_string(remote_path).ok()?;
            headers.push((header.clone(), template.replace("\"{path}\"", &encoded)));
            shape.url.clone()
        }
        PathPlacement::UrlPath { prefix } => {
            if !path_is_url_safe(remote_path) {
                return None;
            }
            format!(
                "{}{}/{}",
                shape.url.trim_end_matches('/'),
                prefix.trim_end_matches('/'),
                remote_path.trim_start_matches('/')
            )
        }
        PathPlacement::Query { param } => {
            if !path_is_url_safe(remote_path) {
                return None;
            }
            format!("{}?{param}={remote_path}", shape.url)
        }
    };
    Some((url, headers))
}

#[path = "attachments_replication.rs"]
mod replication;
#[cfg(test)]
use replication::{authorize_upload, replication_operator, ValidatedReplication};
pub use replication::{replicate_chunk, replicate_manifest};

#[cfg(test)]
#[path = "attachments_tests.rs"]
mod tests;

mod authority;
