//! Bind a retry to the operation and authority that produced its receipt.

use opensesame_domain::{FrozenIntentV2, Intent, InvocationReceipt, ValidatedGrantChain};
use opensesame_storage::invocations::IdempotencyFingerprint;
use serde_json::{json, Value};

use crate::{Broker, FrozenInvokeInput, InvokeInput};

fn lineage_binding(lineage: Option<&ValidatedGrantChain>) -> Option<Value> {
    lineage.map(|chain| {
        json!({
            "grants": chain.grants(),
            "invalidation_generation": chain.invalidation_generation(),
        })
    })
}

/// V1 permits a fresh intent id, nonce, timestamps, and signature on a retry.
/// Every field that changes the effect or authority is still bound.
///
/// # Errors
///
/// Returns an error if the binding cannot be canonically hashed.
pub fn legacy_fingerprint(input: &InvokeInput) -> anyhow::Result<IdempotencyFingerprint> {
    let intent = &input.intent;
    IdempotencyFingerprint::from_request(&json!({
        "kind": "legacy",
        "organization_id": intent.organization_id,
        "project_id": intent.project_id,
        "principal_id": intent.principal_id,
        "actor_id": intent.actor_id,
        "actor_instance_id": intent.actor_instance_id,
        "client_id": intent.client_id,
        "operator_id": intent.operator_id,
        "connection_id": intent.connection_id,
        "operation": intent.operation,
        "resource": intent.resource,
        "audience": intent.audience,
        "parameters_hash": intent.normalized_parameters_hash,
        "body_hash": intent.body_hash,
        "idempotency_key": intent.idempotency_key,
        "parent_invocation_id": intent.parent_invocation_id,
        "delegation_chain": intent.delegation_chain,
        "proof_algorithm": intent.proof.algorithm,
        "proof_key_thumbprint": intent.proof.key_thumbprint,
        "subject": input.subject,
        "connection_policy_id": input.connection_policy_id,
        "grant": input.grant,
        "validated_lineage": lineage_binding(input.lineage.as_ref()),
    }))
}

/// Frozen intents replay only the same immutable, task-bound intent digest.
pub(crate) fn frozen_fingerprint(
    input: &FrozenInvokeInput,
    intent: &FrozenIntentV2,
) -> anyhow::Result<IdempotencyFingerprint> {
    IdempotencyFingerprint::from_request(&json!({
        "kind": "frozen",
        "intent_digest": intent.intent_digest,
        "subject": input.subject,
        "connection_policy_id": input.connection_policy_id,
        "grant": input.grant,
        "validated_lineage": lineage_binding(input.lineage.as_ref()),
        "required_capability": input.required_capability.canonicalize(),
    }))
}

impl Broker {
    pub(crate) async fn prior_receipt(
        &self,
        intent: &Intent,
        fingerprint: &IdempotencyFingerprint,
        frozen_digest: Option<&str>,
    ) -> anyhow::Result<Option<InvocationReceipt>> {
        let Some(existing) = self
            .db
            .find_idempotent_intent(&intent.organization_id, &intent.idempotency_key)
            .await?
        else {
            return Ok(None);
        };
        // Pre-upgrade entries have no binding, so they cannot safely be
        // interpreted as retries, even if some visible intent fields match.
        anyhow::ensure!(
            existing.fingerprint.as_ref() == Some(fingerprint),
            "idempotency conflict: the prior request has a different or missing binding"
        );
        let expected_digest = match frozen_digest {
            Some(digest) => {
                anyhow::ensure!(
                    existing.intent.proof.algorithm == "task-bound"
                        && existing.intent.proof.signature == digest,
                    "idempotency conflict: stored frozen intent does not match"
                );
                digest.to_owned()
            }
            None => existing.intent.digest()?,
        };
        if let Some(receipt) = self
            .db
            .find_receipt_by_idempotency(&intent.organization_id, &intent.idempotency_key)
            .await?
        {
            // Version alone is not provenance: authenticate the stored body
            // and independently enforce the opaque result shape. A receipt
            // signed by a retired key is withheld until replay has a verifier
            // for that key; never re-execute the external effect instead.
            anyhow::ensure!(
                receipt.has_opaque_result()
                    && self.signer.verify_receipt(&receipt).is_ok()
                    && receipt.intent_digest == expected_digest
                    && receipt.idempotency_binding.as_deref() == Some(fingerprint.digest()),
                "idempotency conflict: prior receipt is not safely disclosable"
            );
            return Ok(Some(receipt));
        }
        anyhow::bail!("idempotency conflict: prior intent has no receipt yet")
    }
}
