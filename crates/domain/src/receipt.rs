use crate::{
    ActorId, ActorInstanceId, ApprovalId, ClientId, ConnectionId, CredentialHandleId, DomainError,
    GrantId, InvocationId, OperatorId, OrganizationId, PrincipalId, ReceiptId, TaskRunId,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// A broker receipt whose result contains no provider- or connector-owned data.
pub const OPAQUE_RESULT_RECEIPT_SCHEMA_VERSION: u32 = 5;

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
    pub intent_digest: String,
    /// Signed binding of the operation, authority, and idempotency context.
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
    /// binding; schema 5 requires an opaque provider result and can withhold
    /// a provider-controlled outcome.
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
                "receipt schema 5 requires an opaque result".into(),
            ));
        }
        Ok(())
    }

    /// Only the explicitly versioned, host-owned result shape is eligible for
    /// disclosure. Older receipts may contain data derived from a credential.
    #[must_use]
    pub fn has_opaque_result(&self) -> bool {
        self.receipt_schema_version == OPAQUE_RESULT_RECEIPT_SCHEMA_VERSION
            && self.safe_result_summary.is_none()
            && self.external_request_digest.is_none()
            && self.external_response_digest.is_none()
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
        assert!(r.has_opaque_result());
        assert!(r.assert_schema_invariants().is_ok());
        r.external_request_digest = Some("1-ssecca-ecar".into());
        assert!(!r.has_opaque_result());
        assert!(r.assert_schema_invariants().is_err());
    }
}
