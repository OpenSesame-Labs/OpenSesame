//! Operator-authorized, client-driven attachment uploads.

use super::*;
use opensesame_domain::OrganizationId;

/// The only principal currently authorized to use the target's credential.
/// A native session's organization membership does not grant this authority.
pub(super) struct ReplicationOperator {
    organization: OrganizationId,
    expected_target: Option<String>,
}

pub(super) fn replication_operator(
    st: &AppState,
    headers: &axum::http::HeaderMap,
) -> Result<ReplicationOperator, Response> {
    require_operator(st, headers)?;
    let expected_target = headers
        .get("x-opensesame-attachment-target")
        .map(|value| {
            value
                .to_str()
                .ok()
                .filter(|value| value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()))
                .map(str::to_owned)
                .ok_or_else(|| {
                    (
                        StatusCode::BAD_REQUEST,
                        Json(json!({"error":"invalid_attachment_target_version"})),
                    )
                        .into_response()
                })
        })
        .transpose()?;
    Ok(ReplicationOperator {
        organization: st.connection_organization,
        expected_target,
    })
}

/// A validated operation includes the exact object name it may write. Chunks
/// are named by their verified ciphertext hash; manifests by logical path.
enum ReplicationOperation {
    Chunk { digest: String },
    Manifest { logical_path: String },
}

pub(super) struct ValidatedReplication {
    operation: ReplicationOperation,
    body: Bytes,
}

impl ValidatedReplication {
    pub(super) fn chunk(digest: &str, body: Bytes) -> Result<Self, Response> {
        if !valid_digest(digest) {
            return Err(unprocessable(
                "invalid_digest",
                "digest must be 64 hexadecimal characters",
            ));
        }
        if body.is_empty() {
            return Err(unprocessable("empty_body", "a chunk frame cannot be empty"));
        }
        let actual = blake3::hash(&body).to_hex().to_string();
        if actual != digest.to_ascii_lowercase() {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": "digest_mismatch",
                    "hint": "the body does not hash to the claimed digest",
                })),
            )
                .into_response());
        }
        Ok(Self {
            operation: ReplicationOperation::Chunk { digest: actual },
            body,
        })
    }

    pub(super) fn manifest(logical_path: String, body: Bytes) -> Result<Self, Response> {
        if !valid_logical_path(&logical_path) {
            return Err(unprocessable(
                "invalid_path",
                "path must be a store-logical path such as Taxes/2025, with no '..' or empty segments",
            ));
        }
        if body.is_empty() {
            return Err(unprocessable("empty_body", "a manifest cannot be empty"));
        }
        Ok(Self {
            operation: ReplicationOperation::Manifest { logical_path },
            body,
        })
    }

    #[cfg(test)]
    pub(super) fn observed(&self, folder: &str) -> (String, &Bytes) {
        (self.operation.remote_path(folder), &self.body)
    }
}

impl ReplicationOperation {
    fn remote_path(&self, folder: &str) -> String {
        match self {
            Self::Chunk { digest } => {
                format!("{folder}/objects/{}/{digest}.oschunk", &digest[..2])
            }
            Self::Manifest { logical_path } => {
                format!("{folder}/manifests/{logical_path}.osattach")
            }
        }
    }
}

/// Non-deserializable proof of one operator-authorized upload. It carries the
/// exact organization, configured connection, operation, path, and body to
/// the credential-injecting sink; none can be substituted at the sink.
pub(super) struct AuthorizedAttachmentUpload {
    operator: ReplicationOperator,
    target: AttachmentTarget,
    validated: ValidatedReplication,
}

#[cfg(test)]
impl AuthorizedAttachmentUpload {
    pub(super) fn observed(&self) -> (OrganizationId, &str, String, &Bytes) {
        (
            self.operator.organization,
            &self.target.connection_id,
            self.validated
                .operation
                .remote_path(&self.target.folder_path),
            &self.validated.body,
        )
    }
}

pub(super) async fn authorize_upload(
    st: &AppState,
    operator: ReplicationOperator,
    validated: ValidatedReplication,
) -> Result<AuthorizedAttachmentUpload, Response> {
    let target = active_target(st, &operator.organization.to_string()).await?;
    if operator
        .expected_target
        .as_ref()
        .is_some_and(|expected| expected != &target_replication_version(&target))
    {
        return Err((
            StatusCode::CONFLICT,
            Json(json!({"error":"attachment_target_changed", "hint":"read the target again and restart the sync"})),
        )
            .into_response());
    }
    Ok(AuthorizedAttachmentUpload {
        operator,
        target,
        validated,
    })
}

/// Push one authorized sealed object to its configured provider, recording a
/// failure against the target so an operator can see why replication stopped.
async fn upload(st: &AppState, authorized: AuthorizedAttachmentUpload) -> Response {
    let AuthorizedAttachmentUpload {
        operator,
        target,
        validated: ValidatedReplication { operation, body },
    } = authorized;
    let remote_path = operation.remote_path(&target.folder_path);
    let Some(shape) = upload_shape(&target.provider_id) else {
        return unprocessable(
            "provider_unsupported_for_attachments",
            "the configured provider no longer declares an attachment_upload shape",
        );
    };
    let Some((url, headers)) = render_upload(shape, &remote_path) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid_request","hint":"remote path is not renderable"})),
        )
            .into_response();
    };
    match st
        .connection_broker
        .authorized_bytes(
            &operator.organization,
            &target.connection_id,
            &url,
            &headers,
            body.to_vec(),
        )
        .await
    {
        Ok(()) => {
            let _ = st
                .db
                .record_attachment_target_error(&target.organization_id, None)
                .await;
            (StatusCode::OK, Json(json!({ "stored": true }))).into_response()
        }
        Err(error) => {
            let message = error.to_string();
            let _ = st
                .db
                .record_attachment_target_error(&target.organization_id, Some(&message))
                .await;
            (
                StatusCode::BAD_GATEWAY,
                Json(json!({"error":"upstream_upload_failed","hint": message})),
            )
                .into_response()
        }
    }
}

#[derive(Deserialize)]
pub struct ChunkQuery {
    pub digest: String,
}

pub async fn replicate_chunk(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(query): Query<ChunkQuery>,
    body: Bytes,
) -> Response {
    let operator = match replication_operator(&st, &headers) {
        Ok(operator) => operator,
        Err(resp) => return resp,
    };
    let validated = match ValidatedReplication::chunk(&query.digest, body) {
        Ok(validated) => validated,
        Err(resp) => return resp,
    };
    let authorized = match authorize_upload(&st, operator, validated).await {
        Ok(authorized) => authorized,
        Err(resp) => return resp,
    };
    upload(&st, authorized).await
}

#[derive(Deserialize)]
pub struct ManifestQuery {
    pub path: String,
}

pub async fn replicate_manifest(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(query): Query<ManifestQuery>,
    body: Bytes,
) -> Response {
    let operator = match replication_operator(&st, &headers) {
        Ok(operator) => operator,
        Err(resp) => return resp,
    };
    let validated = match ValidatedReplication::manifest(query.path, body) {
        Ok(validated) => validated,
        Err(resp) => return resp,
    };
    let authorized = match authorize_upload(&st, operator, validated).await {
        Ok(authorized) => authorized,
        Err(resp) => return resp,
    };
    upload(&st, authorized).await
}
