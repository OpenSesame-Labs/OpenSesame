//! Recover evidence for an already-settled frozen invocation without dispatch.

use opensesame_domain::{
    Capability, InvocationReceipt, ReceiptId, ResourceSelector, FROZEN_INTENT_SCHEMA_VERSION,
};

use crate::{frozen::legacy_intent, idempotency::frozen_fingerprint, Broker, FrozenInvokeInput};

impl Broker {
    /// Re-prove the exact frozen intent, original subject and authority binding,
    /// then return the existing authenticated receipt. This cannot execute work.
    ///
    /// # Errors
    /// Returns an error for any mismatched, unavailable or unverifiable evidence.
    pub async fn recover_frozen_receipt(
        &self,
        mut input: FrozenInvokeInput,
    ) -> anyhow::Result<InvocationReceipt> {
        input.intent = input.intent.with_computed_digest()?;
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
        let fingerprint = frozen_fingerprint(&input, intent)?;
        let receipt = self
            .prior_receipt(
                &legacy_intent(intent)?,
                &fingerprint,
                Some(&intent.intent_digest),
            )
            .await?
            .ok_or_else(|| anyhow::anyhow!("receipt unavailable"))?;
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
