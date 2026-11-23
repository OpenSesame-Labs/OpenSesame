use crate::{
    ActorId, ActorInstanceId, ApprovalId, ClientId, ConnectionId, CredentialHandleId, DomainError,
    GrantId, InvocationId, OperatorId, OrganizationId, PrincipalId, ReceiptId, TaskRunId,
};
use opensesame_time::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// A broker receipt whose result contains no provider- or connector-owned data.
pub const OPAQUE_RESULT_RECEIPT_SCHEMA_VERSION: u32 = 6;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReceiptOutcome {
    Succeeded,
    Failed,
    Denied,
    Cancelled,
    /// The operation ran, but its provider-controlled outcome is withheld.
    Indeterminate,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InvocationReceipt {
    pub id: ReceiptId,
    pub invocation_id: InvocationId,
    /// In schema 6, a salted commitment to the authorized intent digest.
    pub intent_digest: String,
    /// Signed, keyed commitment to the operation and authority used for retry.
    /// Absent from historical receipts and non-invocation evidence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_binding: Option<String>,
    pub principal_id: PrincipalId,
    /// Organization whose authority produced this receipt. Legacy schema 1/2
    /// receipts omit it; storage resolves those through the invocation intent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization_id: Option<OrganizationId>,
    pub actor_id: ActorId,
    pub actor_instance_id: Option<ActorInstanceId>,
    pub client_id: Option<ClientId>,
    pub operator_id: Option<OperatorId>,
    pub delegation_chain: Vec<GrantId>,
    pub connection_id: Option<ConnectionId>,
    pub operation: String,
    pub resource: String,
    pub policy_decision_id: String,
    pub policy_version_digest: String,
    pub approval_id: Option<ApprovalId>,
    pub credential_handle_id: Option<CredentialHandleId>,
    pub connector_component_digest: Option<String>,
    pub external_request_digest: Option<String>,
    pub external_response_digest: Option<String>,
    pub started_at: DateTime<Utc>,
    pub completed_at: DateTime<Utc>,
    pub outcome: ReceiptOutcome,
    pub safe_result_summary: Option<serde_json::Value>,
    pub authority_key_id: String,
    pub signature: String,
    /// Schema 1 = legacy; schema 2 adds task binding; schema 3 adds organization
    /// binding; schema 6 requires an opaque provider result and opened intent
    /// commitment, and can withhold a provider-controlled outcome.
    #[serde(default = "default_receipt_schema_version")]
    pub receipt_schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_run_id: Option<TaskRunId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_state_version: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_state_digest: Option<String>,
}

fn default_receipt_schema_version() -> u32 {
    1
}

fn is_keyed_commitment(value: &str) -> bool {
    value.strip_prefix("hmac-sha256:v1:").is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

/// Domain separation for a receipt's private-opening intent commitment.
const RECEIPT_INTENT_OPENING_DOMAIN: &[u8] = b"OpenSesame/ReceiptIntentOpening/v1\0";

fn is_sha256_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

/// Construct a public receipt commitment from a private opening and the
/// original intent digest. The opening is sensitive: anyone holding it can
/// check guesses about low-entropy intent contents.
///
/// # Errors
/// Returns an error for a malformed opening or intent digest.
pub fn receipt_intent_commitment(
    opening: &str,
    intent_digest: &str,
) -> Result<String, DomainError> {
    if !is_keyed_commitment(opening) || !is_sha256_digest(intent_digest) {
        return Err(DomainError::Canonicalization(
            "invalid receipt intent opening".into(),
        ));
    }
    let mut bytes = Vec::with_capacity(
        RECEIPT_INTENT_OPENING_DOMAIN.len() + opening.len() + intent_digest.len() + 1,
    );
    bytes.extend_from_slice(RECEIPT_INTENT_OPENING_DOMAIN);
    bytes.extend_from_slice(opening.as_bytes());
    bytes.push(0);
    bytes.extend_from_slice(intent_digest.as_bytes());
    Ok(crate::digest_sha256(&bytes))
}

impl InvocationReceipt {
    /// Enforce invariants introduced by the receipt schema while retaining
    /// verification compatibility for legacy schema 1 and 2 evidence.
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn assert_schema_invariants(&self) -> Result<(), DomainError> {
        if self.receipt_schema_version >= 3 && self.organization_id.is_none() {
            return Err(DomainError::Canonicalization(
                "receipt schema 3 requires organization_id".into(),
            ));
        }
        if self.receipt_schema_version == OPAQUE_RESULT_RECEIPT_SCHEMA_VERSION
            && !self.has_opaque_result()
        {
            return Err(DomainError::Canonicalization(
                "receipt schema 6 requires an opaque result and intent commitment".into(),
            ));
        }
        Ok(())
    }

    /// Only the explicitly versioned, host-owned result shape is eligible for
    /// disclosure. Older receipts may contain data derived from a credential.
    #[must_use]
    pub fn has_opaque_result(&self) -> bool {
        self.receipt_schema_version == OPAQUE_RESULT_RECEIPT_SCHEMA_VERSION
            && is_sha256_digest(&self.intent_digest)
            && self.safe_result_summary.is_none()
            && self.external_request_digest.is_none()
            && self.external_response_digest.is_none()
    }

    /// Verify an opening against this receipt's commitment. This does not
    /// verify the receipt signature; consumers must check that separately.
    #[must_use]
    pub fn verifies_intent_opening(&self, opening: &str, intent_digest: &str) -> bool {
        self.receipt_schema_version == OPAQUE_RESULT_RECEIPT_SCHEMA_VERSION
            && receipt_intent_commitment(opening, intent_digest)
                .is_ok_and(|commitment| commitment == self.intent_digest)
    }

    /// A prior unkeyed binding can reveal low-entropy request parameters.
    /// Keep legacy signatures verifiable, but do not disclose that binding.
    #[must_use]
    pub fn has_confidential_idempotency_binding(&self) -> bool {
        self.idempotency_binding
            .as_deref()
            .is_none_or(is_keyed_commitment)
    }

    /// Ensure no obvious secret-bearing keys appear in the safe summary.
    #[must_use]
    pub fn assert_no_secret_leak(&self) -> bool {
        let Some(summary) = &self.safe_result_summary else {
            return true;
        };
        let s = summary.to_string().to_lowercase();
        let banned = [
            "refresh_token",
            "access_token",
            "password",
            "private_key",
            "authorization_code",
            "device_code",
            "claim_token",
            "client_secret",
        ];
        !banned.iter().any(|b| s.contains(b))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receipt_opening_matches_the_cross_language_vector() {
        let opening = format!("hmac-sha256:v1:{}", "a".repeat(64));
        let digest = format!("sha256:{}", "b".repeat(64));
        assert_eq!(
            receipt_intent_commitment(&opening, &digest).unwrap(),
            "sha256:74496e4d5230a7dfebaaa61412cc8b9a98bced0f7b7135669916ca9bfd91406b"
        );
        assert!(receipt_intent_commitment("hmac-sha256:v1:short", &digest).is_err());
        assert!(receipt_intent_commitment(&opening, "sha256:SHORT").is_err());
    }

    #[test]
    fn detects_secret_keys_in_summary() {
        let mut r = InvocationReceipt {
            id: ReceiptId::new(),
            invocation_id: InvocationId::new(),
            intent_digest: "sha256:abc".into(),
            idempotency_binding: None,
            principal_id: PrincipalId::new(),
            organization_id: None,
            actor_id: ActorId::new(),
            actor_instance_id: None,
            client_id: None,
            operator_id: None,
            delegation_chain: vec![],
            connection_id: None,
            operation: "x".into(),
            resource: "y".into(),
            policy_decision_id: "d".into(),
            policy_version_digest: "p".into(),
            approval_id: None,
            credential_handle_id: None,
            connector_component_digest: None,
            external_request_digest: None,
            external_response_digest: None,
            started_at: Utc::now(),
            completed_at: Utc::now(),
            outcome: ReceiptOutcome::Succeeded,
            safe_result_summary: Some(serde_json::json!({"access_token": "nope"})),
            authority_key_id: "k".into(),
            signature: "s".into(),
            receipt_schema_version: 1,
            task_run_id: None,
            task_state_version: None,
            task_state_digest: None,
        };
        assert!(!r.assert_no_secret_leak());
        r.safe_result_summary = Some(serde_json::json!({"pr_number": 12}));
        assert!(r.assert_no_secret_leak());

        r.receipt_schema_version = 3;
        assert!(r.assert_schema_invariants().is_err());
        r.organization_id = Some(OrganizationId::new());
        r.assert_schema_invariants().unwrap();

        r.receipt_schema_version = OPAQUE_RESULT_RECEIPT_SCHEMA_VERSION;
        assert!(!r.has_opaque_result());
        assert!(r.assert_schema_invariants().is_err());
        r.safe_result_summary = None;
        assert!(!r.has_opaque_result());
        r.intent_digest = format!("sha256:{}", "b".repeat(64));
        assert!(r.has_opaque_result());
        assert!(r.assert_schema_invariants().is_ok());
        assert!(r.has_confidential_idempotency_binding());
        r.idempotency_binding = Some("sha256:guessable".into());
        assert!(!r.has_confidential_idempotency_binding());
        r.idempotency_binding = Some(format!("hmac-sha256:v1:{}", "a".repeat(64)));
        assert!(r.has_confidential_idempotency_binding());
        r.idempotency_binding = Some("hmac-sha256:v1:abc".into());
        assert!(!r.has_confidential_idempotency_binding());
        r.external_request_digest = Some("1-ssecca-ecar".into());
        assert!(!r.has_opaque_result());
        assert!(r.assert_schema_invariants().is_err());
    }
}
