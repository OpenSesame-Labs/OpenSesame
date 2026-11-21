//! Recover evidence for an already-settled frozen invocation without dispatch.

use opensesame_domain::{
    AvailabilityClass, Capability, DomainError, InvocationReceipt, ReceiptId, ResourceSelector,
    FROZEN_INTENT_SCHEMA_VERSION,
};
use opensesame_task_access::{TaskAccessEngine, TaskStore};
use opensesame_time::Utc;

use crate::{
    frozen::{frozen_authz_request, legacy_intent},
    idempotency::frozen_fingerprint,
    Broker, FrozenInvokeInput,
};

impl Broker {
    /// Re-prove the exact frozen intent, original subject and authority binding,
    /// then return the existing authenticated receipt. This cannot execute work.
    ///
    /// Replay uses the same freshness, grant, task, quorum, and policy gates as
    /// [`Broker::invoke_frozen`] before a stored receipt is disclosed.
    ///
    /// # Errors
    /// Returns an error for any mismatched, unavailable or unverifiable evidence.
    pub async fn recover_frozen_receipt<S: TaskStore>(
        &self,
        tasks: &TaskAccessEngine<S>,
        input: FrozenInvokeInput,
    ) -> anyhow::Result<InvocationReceipt> {
        let now = Utc::now();
        input.intent.assert_fresh(now)?;
        input.grant.assert_active(now)?;
        // The frozen snapshot is evidence. Recomputing the digest would accept
        // a mutated intent that was never executed.
        input.intent.assert_digest()?;
        let intent = &input.intent;
        anyhow::ensure!(
            intent.schema_version == FROZEN_INTENT_SCHEMA_VERSION,
            "unsupported frozen intent"
        );
        crate::assert_grant_covers_frozen_intent(&input.grant, intent)?;
        let required = Capability::new(
            intent.operation.clone(),
            ResourceSelector::exact(intent.resource.clone()),
        );
        anyhow::ensure!(input.required_capability == required, "capability mismatch");
        let run = tasks.assert_capability(
            intent.task_run_id,
            &required,
            intent.task_state_version,
            now,
        )?;
        if run.state_digest != intent.task_state_digest {
            return Err(DomainError::TaskStateVersionMismatch {
                expected: intent.task_state_version,
                actual: run.state_version,
            }
            .into());
        }
        tasks.assert_ceiling_unchanged(&run)?;
        if !self.db.authority_quorum_ok().await? {
            return Err(
                DomainError::AuthorityUnavailable(AvailabilityClass::A3ExternalSideEffect).into(),
            );
        }
        let fingerprint = frozen_fingerprint(&input, intent)?;
        let decision = self.policy.decide(
            &frozen_authz_request(&input, intent),
            Some(&input.grant),
            input.lineage.as_ref(),
            AvailabilityClass::A3ExternalSideEffect,
        )?;
        let receipt = self
            .prior_receipt(
                &legacy_intent(intent)?,
                &fingerprint,
                Some(&intent.intent_digest),
            )
            .await?
            .ok_or_else(|| anyhow::anyhow!("receipt unavailable"))?;
        anyhow::ensure!(
            decision.decision,
            "idempotency conflict: current authorization denied"
        );
        anyhow::ensure!(
            receipt.id == ReceiptId::from_uuid(intent.id.as_uuid())
                && receipt.task_run_id == Some(intent.task_run_id)
                && receipt.task_state_version == Some(intent.task_state_version)
                && receipt.task_state_digest.as_deref() == Some(intent.task_state_digest.as_str()),
            "receipt does not match the frozen intent"
        );
        Ok(receipt)
    }
}
