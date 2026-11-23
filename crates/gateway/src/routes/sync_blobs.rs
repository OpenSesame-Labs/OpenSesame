//! Opaque ciphertext sync-blob routes.
//!
//! Host stores `{ id, epoch, ciphertext }` only. This module never decrypts,
//! never returns plaintext, and never uses the deployment / connection seal
//! key as a wrap key for client backups (ADR 0032 / WP-F).

use axum::{
    extract::{rejection::JsonRejection, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use opensesame_client_core::SyncBlob;
use opensesame_storage::StoredSyncBlob;
use serde::Deserialize;
use serde_json::json;

use crate::app_state::AppState;
use crate::middleware::auth::require_session;

/// Wire view of a stored sync blob — ciphertext only.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct OpaqueSyncBlobDto {
    pub id: String,
    pub epoch: u64,
    pub ciphertext: Vec<u8>,
}

impl From<StoredSyncBlob> for OpaqueSyncBlobDto {
    fn from(blob: StoredSyncBlob) -> Self {
        Self {
            id: blob.id,
            epoch: blob.epoch,
            ciphertext: blob.ciphertext,
        }
    }
}

impl From<SyncBlob> for OpaqueSyncBlobDto {
    fn from(blob: SyncBlob) -> Self {
        Self {
            id: blob.id,
            epoch: blob.epoch,
            ciphertext: blob.ciphertext,
        }
    }
}

impl From<OpaqueSyncBlobDto> for SyncBlob {
    fn from(blob: OpaqueSyncBlobDto) -> Self {
        Self {
            id: blob.id,
            epoch: blob.epoch,
            ciphertext: blob.ciphertext,
        }
    }
}

const FORBIDDEN_PLAINTEXT_KEYS: &[&str] = &[
    "plaintext",
    "secret",
    "password",
    "token",
    "vrk",
    "vault_key",
    "master_password",
    "connection_key",
    "deployment_seal",
];

/// Whether a JSON field name smuggles plaintext or a deployment-seal value.
fn smuggles_plaintext(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    FORBIDDEN_PLAINTEXT_KEYS
        .iter()
        .any(|forbidden| lower == *forbidden || lower.contains(forbidden))
}

/// Validate a single blob is opaque ciphertext with non-empty payload.
pub fn validate_opaque_blob(blob: &OpaqueSyncBlobDto) -> Result<(), &'static str> {
    if blob.id.is_empty() {
        return Err("blob_id_empty");
    }
    if blob.ciphertext.is_empty() {
        return Err("ciphertext_empty");
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct SyncBlobsSnapshotQuery {
    #[serde(default)]
    after: Option<super::sync_page::Cursor>,
    #[serde(default)]
    limit: Option<u32>,
    #[serde(default)]
    since_epoch: u64,
    #[serde(default)]
    project_id: Option<String>,
}

/// List the caller's sync blobs as opaque ciphertext (offline cache / backup source).
pub async fn snapshot(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<SyncBlobsSnapshotQuery>,
) -> Response {
    if body.after.is_none() && body.since_epoch != 0 {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"sync_cursor_upgrade_required","restart_after":null})),
        )
            .into_response();
    }
    super::sync_page::serve_page(
        &st,
        &headers,
        super::sync_page::PageQuery {
            after: body.after.or_else(|| {
                Some(super::sync_page::Cursor {
                    epoch: body.since_epoch.saturating_add(1),
                    id: String::new(),
                })
            }),
            limit: body.limit,
            device_id: None,
        },
        true,
        body.project_id,
    )
    .await
}

pub(super) fn project_scoped(blob_id: &str, project_id: Option<&str>) -> bool {
    let Some(project_id) = project_id.filter(|p| !p.is_empty()) else {
        return true;
    };
    if blob_id == project_id {
        return true;
    }
    blob_id.starts_with(&format!("project:{project_id}:"))
        || blob_id.starts_with(&format!("{project_id}/"))
}

/// Push path that additionally rejects plaintext-smuggling JSON envelopes.
///
/// The body is decoded straight into the opaque wire shape
/// (`{"blobs":[{"id","epoch","ciphertext"}]}`) and nothing else: a field
/// named like plaintext or a seal is refused as such, any other extra field
/// as an invalid push, and no untyped JSON is ever held.
pub async fn push_opaque(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    body: Result<Json<wire::SyncPushOpaqueBody>, JsonRejection>,
) -> Response {
    if let Err(resp) = require_session(&st, &headers) {
        return resp;
    }
    let body = match wire::opaque_push_body(body) {
        Ok(body) => body,
        Err((status, code)) => return (status, Json(json!({"error": code}))).into_response(),
    };
    for blob in &body.blobs {
        if let Err(code) = validate_opaque_blob(blob) {
            return (StatusCode::BAD_REQUEST, Json(json!({"error": code}))).into_response();
        }
    }
    // Reuse the existing durable push path by adapting DTOs → SyncBlob.
    super::sync::push(
        State(st),
        headers,
        Json(super::sync::SyncPushBody {
            blobs: body.blobs.into_iter().map(SyncBlob::from).collect(),
        }),
    )
    .await
}

#[path = "sync_blobs_wire.rs"]
mod wire;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smuggled_field_names_are_recognised() {
        for key in [
            "plaintext",
            "deployment_seal",
            "Password",
            "vaultKey_token",
            "vrk",
        ] {
            assert!(smuggles_plaintext(key), "{key}");
        }
        for key in ["id", "epoch", "ciphertext", "blobs"] {
            assert!(!smuggles_plaintext(key), "{key}");
        }
    }

    #[test]
    fn validate_requires_ciphertext() {
        assert!(validate_opaque_blob(&OpaqueSyncBlobDto {
            id: "a".into(),
            epoch: 1,
            ciphertext: vec![9],
        })
        .is_ok());
        assert_eq!(
            validate_opaque_blob(&OpaqueSyncBlobDto {
                id: "a".into(),
                epoch: 1,
                ciphertext: vec![],
            }),
            Err("ciphertext_empty")
        );
    }

    #[test]
    fn project_scope_filters() {
        assert!(project_scoped("project:p1:x", Some("p1")));
        assert!(!project_scoped("project:p2:x", Some("p1")));
        assert!(project_scoped("anything", None));
    }

    #[tokio::test]
    async fn snapshot_without_session_fails_closed() {
        let state = crate::app_state::test_demo_state().await;
        let response = snapshot(
            State(state),
            axum::http::HeaderMap::new(),
            Json(SyncBlobsSnapshotQuery {
                after: None,
                limit: None,
                since_epoch: 0,
                project_id: None,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn push_without_session_fails_closed() {
        let state = crate::app_state::test_demo_state().await;
        let response = push_opaque(
            State(state),
            axum::http::HeaderMap::new(),
            Ok(Json(wire::SyncPushOpaqueBody {
                blobs: vec![OpaqueSyncBlobDto {
                    id: "a".into(),
                    epoch: 1,
                    ciphertext: vec![1],
                }],
            })),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
}
