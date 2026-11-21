//! Authorize-and-execute path that never accepts a second mutable parameter blob.

use opensesame_authz::{AuthZenAction, AuthZenRequest, AuthZenResource, AuthZenSubject};
use opensesame_connector_host::{InvocationBinding, InvokeRequest};
use opensesame_domain::{
    receipt_delegation_chain, AvailabilityClass, Capability, DetachedProof, DomainError,
    FrozenIntentV2, Grant, Intent, Invocation, InvocationReceipt, InvocationState, ReceiptId,
    ReceiptOutcome, ResourceSelector, ValidatedGrantChain, FROZEN_INTENT_SCHEMA_VERSION,
    OPAQUE_RESULT_RECEIPT_SCHEMA_VERSION,
};
use opensesame_task_access::{TaskAccessEngine, TaskStore};
use opensesame_time::Utc;
use serde_json::json;

use crate::{Broker, FinishReceiptParts};

/// Authority-bearing invoke: frozen intent bytes only (no separate parameters).
pub struct FrozenInvokeInput {
    pub intent: FrozenIntentV2,
    pub grant: Grant,
    pub subject: String,
    pub connection_policy_id: String,
    /// Required capability for the operation within the task current set.
    pub required_capability: Capability,
    /// Verified lineage for delegated exercise; omit for root/owner grants.
    pub lineage: Option<ValidatedGrantChain>,
}

/// Every scoped grant field must cover the frozen intent (ADR 0027).
///
/// `None` on the grant is unscoped; `Some` requires the intent to name the same
/// value.
///
/// # Errors
///
/// [`DomainError::OrganizationMismatch`] for another organization's intent;
/// [`DomainError::AuthorizationDenied`] naming the first scoped field it misses.
pub fn assert_grant_covers_frozen_intent(
    grant: &Grant,
    intent: &FrozenIntentV2,
) -> Result<(), DomainError> {
    let denied = |what: &str| {
        Err(DomainError::AuthorizationDenied(format!(
            "grant does not cover this intent: {what}"
        )))
    };
    if intent.organization_id != grant.organization_id {
        return Err(DomainError::OrganizationMismatch);
    }
    if grant.beneficiary_principal_id != intent.principal_id {
        return denied("beneficiary principal");
    }
    if grant.project_id.is_some() && intent.project_id != grant.project_id {
        return denied("project");
    }
    if grant.actor_id.is_some_and(|actor| intent.actor_id != actor) {
        return denied("actor");
    }
    if grant.actor_instance_id.is_some() && intent.actor_instance_id != grant.actor_instance_id {
        return denied("actor instance");
    }
    if grant.client_id.is_some() && intent.client_id != grant.client_id {
        return denied("client");
    }
    if grant.connection_id.is_some() && intent.connection_id != grant.connection_id {
        return denied("connection");
    }
    Ok(())
}

pub(crate) fn legacy_intent(intent: &FrozenIntentV2) -> Result<Intent, DomainError> {
    Ok(Intent {
        id: intent.id,
        organization_id: intent.organization_id,
        project_id: intent.project_id,
        principal_id: intent.principal_id,
        actor_id: intent.actor_id,
        actor_instance_id: intent.actor_instance_id,
        client_id: intent.client_id,
        operator_id: intent.operator_id,
        connection_id: intent.connection_id,
        operation: intent.operation.clone(),
        resource: intent.resource.clone(),
        audience: intent.audience.clone(),
        normalized_parameters_hash: Intent::parameters_hash(&intent.canonical_arguments)?,
        body_hash: intent.body_hash.clone(),
        nonce: intent.nonce.clone(),
        idempotency_key: intent.idempotency_key.clone(),
        issued_at: intent.issued_at,
        expires_at: intent.expires_at,
        parent_invocation_id: None,
        delegation_chain: vec![],
        proof: DetachedProof {
            algorithm: "task-bound".into(),
            key_thumbprint: "task".into(),
            signature: intent.intent_digest.clone(),
        },
    })
}

pub(crate) fn frozen_authz_request(
    input: &FrozenInvokeInput,
    intent: &FrozenIntentV2,
) -> AuthZenRequest {
    AuthZenRequest {
        subject: AuthZenSubject {
            type_: "user".into(),
            id: input.subject.clone(),
            properties: json!({
                "assurance": input.grant.constraints.required_assurance,
                "task_run_id": intent.task_run_id.to_string(),
                "task_state_version": intent.task_state_version,
            }),
        },
        action: AuthZenAction {
            name: intent.operation.clone(),
        },
        resource: AuthZenResource {
            type_: "connector_operation".into(),
            id: intent.resource.clone(),
        },
        context: json!({
            "connection_id": input.connection_policy_id,
            "audience": intent.audience,
            "intent_digest": intent.intent_digest,
            "task_state_digest": intent.task_state_digest,
        }),
    }
}

impl Broker {
    /// Persist digest → authorize that digest → execute canonical arguments from the same intent.
    ///
    /// # Errors
    ///
    /// Returns an error when validation, authorization, execution, or durable
    /// receipt persistence fails.
    pub async fn invoke_frozen<S: TaskStore>(
        &self,
        tasks: &TaskAccessEngine<S>,
        input: FrozenInvokeInput,
    ) -> anyhow::Result<InvocationReceipt> {
        let now = Utc::now();
        input.intent.assert_fresh(now)?;
        input.grant.assert_active(now)?;

        // The authority already froze this intent. Verify that snapshot before
        // using it; recomputing in place would accept post-freeze mutation.
        input.intent.assert_digest()?;
        let intent = input.intent.clone();
        // Same gate as `recover_frozen_receipt`: a well-digest intent of an
        // unknown schema version is not one this broker froze.
        anyhow::ensure!(
            intent.schema_version == FROZEN_INTENT_SCHEMA_VERSION,
            "unsupported frozen intent"
        );

        assert_grant_covers_frozen_intent(&input.grant, &intent)?;

        let required = Capability::new(
            intent.operation.clone(),
            ResourceSelector::exact(intent.resource.clone()),
        );
        anyhow::ensure!(
            input.required_capability == required,
            "required capability does not match the frozen operation"
        );
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

        // Compatibility: store a V1 projection for idempotency tables that expect Intent.
        let legacy = legacy_intent(&intent)?;
        let fingerprint = crate::idempotency::frozen_fingerprint(&input, &intent)?;
        let authz_req = frozen_authz_request(&input, &intent);

        let decision = self.policy.decide(
            &authz_req,
            Some(&input.grant),
            input.lineage.as_ref(),
            AvailabilityClass::A3ExternalSideEffect,
        )?;
        if let Some(receipt) = self
            .prior_receipt(&legacy, &fingerprint, Some(&intent.intent_digest))
            .await?
        {
            anyhow::ensure!(
                decision.decision,
                "idempotency conflict: current authorization denied"
            );
            return Ok(receipt);
        }
        let mut inv = Self::begin_invocation(intent.id, now)?;
        let authority = if decision.decision {
            Some(InvocationBinding::from_frozen(
                inv.id,
                &intent,
                &input.grant,
                &input.subject,
                &input.connection_policy_id,
                input.lineage.as_ref(),
            )?)
        } else {
            None
        };
        self.db.insert_bound_intent(&legacy, &fingerprint).await?;
        if !decision.decision {
            inv.transition(InvocationState::Denied, Utc::now())?;
            let receipt = self.finish_frozen_receipt(
                &intent,
                &inv,
                FinishReceiptParts {
                    decision_id: &decision.decision_id,
                    policy_digest: &decision.policy_version_digest,
                    outcome: ReceiptOutcome::Denied,
                    binding: fingerprint.digest(),
                    connector_digest: self.host.component_digest(&input.connection_policy_id),
                    delegation_chain: receipt_delegation_chain(
                        &input.grant,
                        input.lineage.as_ref(),
                    ),
                },
            )?;
            self.db
                .insert_denied_invocation_with_receipt(&inv, &receipt)
                .await?;
            return Ok(receipt);
        }

        self.execute_frozen_authorized(
            &input,
            &intent,
            (
                inv,
                authority.ok_or_else(|| anyhow::anyhow!("missing invocation context"))?,
            ),
            &decision.decision_id,
            &decision.policy_version_digest,
            fingerprint.digest(),
        )
        .await
    }

    async fn execute_frozen_authorized(
        &self,
        input: &FrozenInvokeInput,
        intent: &FrozenIntentV2,
        invocation: (Invocation, InvocationBinding),
        decision_id: &str,
        policy_digest: &str,
        binding: &str,
    ) -> anyhow::Result<InvocationReceipt> {
        let (mut invocation, authority) = invocation;
        invocation.transition(InvocationState::Authorized, Utc::now())?;
        invocation.transition(InvocationState::Leased, Utc::now())?;
        invocation.lease_owner = Some("worker-local".into());
        invocation.transition(InvocationState::Executing, Utc::now())?;
        self.db.insert_invocation(&invocation).await?;

        // Execute ONLY from frozen canonical_arguments — never a second parameter map.
        let params_digest = Intent::parameters_hash(&intent.canonical_arguments)?;
        let result = self.host.invoke_bound(
            &input.connection_policy_id,
            &InvokeRequest {
                operation: intent.operation.clone(),
                resource: intent.resource.clone(),
                audience: intent.audience.clone(),
                parameters: intent.canonical_arguments.clone(),
                parameters_digest: params_digest,
                authorized_operation: intent.operation.clone(),
                invoke_level: Some(1),
                connection_ref: input.connection_policy_id.clone(),
            },
            &authority,
        );

        let outcome = match result {
            Ok(r) => {
                let (state, outcome) = if r.ok {
                    (InvocationState::Succeeded, ReceiptOutcome::Succeeded)
                } else {
                    (InvocationState::Failed, ReceiptOutcome::Failed)
                };
                invocation.transition(state, Utc::now())?;
                outcome
            }
            Err(_) => {
                invocation.transition(InvocationState::Failed, Utc::now())?;
                ReceiptOutcome::Failed
            }
        };
        let outcome = if self
            .host
            .permits_outcome_disclosure(&input.connection_policy_id)
        {
            outcome
        } else {
            ReceiptOutcome::Indeterminate
        };

        let receipt = self.finish_frozen_receipt(
            intent,
            &invocation,
            FinishReceiptParts {
                decision_id,
                policy_digest,
                outcome,
                binding,
                connector_digest: self.host.component_digest(&input.connection_policy_id),
                delegation_chain: receipt_delegation_chain(&input.grant, input.lineage.as_ref()),
            },
        )?;
        if !receipt.assert_no_secret_leak() {
            anyhow::bail!("receipt summary rejected by secret-leak check");
        }
        self.db
            .finish_executing_invocation(&invocation, &receipt)
            .await?;
        Ok(receipt)
    }

    fn finish_frozen_receipt(
        &self,
        intent: &FrozenIntentV2,
        inv: &Invocation,
        parts: FinishReceiptParts<'_>,
    ) -> anyhow::Result<InvocationReceipt> {
        let receipt = InvocationReceipt {
            id: ReceiptId::from_uuid(intent.id.as_uuid()),
            invocation_id: inv.id,
            intent_digest: self
                .signer
                .intent_commitment(&inv.id, &intent.intent_digest)?,
            idempotency_binding: Some(self.signer.idempotency_commitment(parts.binding)),
            principal_id: intent.principal_id,
            organization_id: Some(intent.organization_id),
            actor_id: intent.actor_id,
            actor_instance_id: intent.actor_instance_id,
            client_id: intent.client_id,
            operator_id: intent.operator_id,
            delegation_chain: parts.delegation_chain,
            connection_id: intent.connection_id,
            operation: intent.operation.clone(),
            resource: intent.resource.clone(),
            policy_decision_id: parts.decision_id.into(),
            policy_version_digest: parts.policy_digest.into(),
            approval_id: None,
            credential_handle_id: None,
            connector_component_digest: parts.connector_digest.map(str::to_owned),
            external_request_digest: None,
            external_response_digest: None,
            started_at: inv.created_at,
            completed_at: Utc::now(),
            outcome: parts.outcome,
            safe_result_summary: None,
            authority_key_id: String::new(),
            signature: String::new(),
            receipt_schema_version: OPAQUE_RESULT_RECEIPT_SCHEMA_VERSION,
            task_run_id: Some(intent.task_run_id),
            task_state_version: Some(intent.task_state_version),
            task_state_digest: Some(intent.task_state_digest.clone()),
        };
        Ok(self.signer.sign_receipt(receipt)?)
    }
}

#[cfg(test)]
#[path = "frozen_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "frozen_outcome_tests.rs"]
mod outcome_tests;

#[cfg(test)]
#[path = "frozen_schema_tests.rs"]
mod schema_tests;
