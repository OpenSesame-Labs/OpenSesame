//! Key-free certificate issuance completion: settle the request and file the
//! certificate in one transaction, with no sealed delivery payload.
//!
//! EST enrollment is the key-free shape — the protocol response itself is the
//! delivery, so there is no pickup blob — but the request still settles
//! through a guarded completion, never a pre-completed insert. Split out of
//! `cert_issuance.rs`, which was at its line budget.

use super::{
    certificate_issuance_state_is_terminal, validate_san_json, Db, StoredManagedCertificate, Utc,
};

impl Db {
    /// Atomically complete a key-free issuance: settle the request and file
    /// its certificate, with no sealed delivery payload. EST enrollment is
    /// the key-free shape — the protocol response itself is the delivery, so
    /// there is no pickup blob — but the request still settles through a
    /// guarded completion, never a pre-completed insert.
    ///
    /// Returns `false` when the request row moved underneath us — a stale
    /// version, an unexpected state, or an expired request — leaving nothing
    /// written, exactly like [`Db::complete_certificate_issuance`].
    ///
    /// # Errors
    ///
    /// Returns an error when the SAN document is malformed, the certificate
    /// does not belong to the request it completes, or the transaction fails.
    pub async fn complete_keyfree_certificate_issuance(
        &self,
        organization_id: &str,
        request_id: &str,
        expected_version: i64,
        expected_state: &str,
        issued: &StoredManagedCertificate,
    ) -> anyhow::Result<bool> {
        if certificate_issuance_state_is_terminal(expected_state) {
            return Ok(false);
        }
        validate_san_json(&issued.san_json)?;
        if issued.organization_id != organization_id || issued.request_id != request_id {
            anyhow::bail!("issued certificate ownership does not match request");
        }
        let now = Utc::now().to_rfc3339();
        let mut transaction = self.pool.begin().await?;
        let settled = sqlx::query(
            "UPDATE certificate_issuance_requests SET state = 'completed', version = version + 1, updated_at = ? \
             WHERE organization_id = ? AND id = ? AND authority_id = ? AND common_name = ? AND san_json = ? \
               AND version = ? AND state = ? AND julianday(expires_at) > julianday(?)",
        )
        .bind(&now)
        .bind(organization_id)
        .bind(request_id)
        .bind(&issued.authority_id)
        .bind(&issued.common_name)
        .bind(&issued.san_json)
        .bind(expected_version)
        .bind(expected_state)
        .bind(&now)
        .execute(&mut *transaction)
        .await?;
        if settled.rows_affected() != 1 {
            transaction.rollback().await?;
            return Ok(false);
        }
        sqlx::query(
            "INSERT INTO issued_certificates (id, organization_id, authority_id, request_id, certificate_digest, serial_number, common_name, san_json, not_before, expires_at, status, application_id, profile_id, source, enrollment_method, metadata_json, key_algorithm, signature_algorithm, fingerprint_sha256, chain_pem, renewed_from_id, renewed_by_id, auto_renew_enabled, renew_before_seconds, revocation_reason, revoked_at, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&issued.id)
        .bind(&issued.organization_id)
        .bind(&issued.authority_id)
        .bind(&issued.request_id)
        .bind(&issued.certificate_digest)
        .bind(&issued.serial_number)
        .bind(&issued.common_name)
        .bind(&issued.san_json)
        .bind(&issued.not_before)
        .bind(&issued.expires_at)
        .bind(&issued.status)
        .bind(&issued.application_id)
        .bind(&issued.profile_id)
        .bind(&issued.source)
        .bind(&issued.enrollment_method)
        .bind(&issued.metadata_json)
        .bind(&issued.key_algorithm)
        .bind(&issued.signature_algorithm)
        .bind(&issued.fingerprint_sha256)
        .bind(&issued.chain_pem)
        .bind(&issued.renewed_from_id)
        .bind(&issued.renewed_by_id)
        .bind(i64::from(issued.auto_renew_enabled))
        .bind(issued.renew_before_seconds)
        .bind(issued.revocation_reason)
        .bind(&issued.revoked_at)
        .bind(issued.version)
        .bind(&issued.created_at)
        .bind(&issued.updated_at)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(true)
    }
}
