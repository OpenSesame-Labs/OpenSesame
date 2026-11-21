mod frozen;
mod frozen_recovery;
mod idempotency;
mod independent_executor;

pub use frozen::{assert_grant_covers_frozen_intent, FrozenInvokeInput};
pub use idempotency::legacy_fingerprint as invocation_fingerprint;

use opensesame_audit::ReceiptSigner;
use opensesame_authz::{
    AuthZenAction, AuthZenRequest, AuthZenResource, AuthZenSubject, PolicyEngine,
};
use opensesame_connector_host::{HostRuntime, InvocationBinding, InvokeRequest};
use opensesame_domain::{
    AvailabilityClass, DomainError, Grant, Intent, Invocation, InvocationId, InvocationReceipt,
    InvocationState, ReceiptId, ReceiptOutcome, ValidatedGrantChain,
    OPAQUE_RESULT_RECEIPT_SCHEMA_VERSION,
};
use opensesame_storage::Db;
use opensesame_time::Utc;
use serde_json::{json, Value};

pub struct Broker {
    pub db: Db,
    pub policy: PolicyEngine,
    pub host: HostRuntime,
    pub signer: ReceiptSigner,
}

pub struct InvokeInput {
    pub intent: Intent,
    pub grant: Grant,
    pub subject: String,
    pub connection_policy_id: String,
    pub parameters: Value,
    /// Verified lineage for delegated exercise. Raw `parent_grant_id` is not
    /// eligibility; omit only for root/owner grants that rely on tuples.
    pub lineage: Option<ValidatedGrantChain>,
}

impl Broker {
    fn begin_invocation(
        intent_id: opensesame_domain::IntentId,
        now: opensesame_time::DateTime<Utc>,
    ) -> anyhow::Result<Invocation> {
        let mut invocation = Invocation {
            id: InvocationId::new(),
            intent_id,
            state: InvocationState::Received,
            attempt: 1,
            lease_owner: None,
            lease_expires_at: None,
            created_at: now,
            updated_at: now,
        };
        invocation.transition(InvocationState::Authorizing, now)?;
        Ok(invocation)
    }

    ///
    /// # Errors
    ///
    /// Returns an error when validation, authorization, execution, or durable
    /// receipt persistence fails.
    pub async fn invoke(&self, input: InvokeInput) -> anyhow::Result<InvocationReceipt> {
        let request = InvokeRequest {
            operation: input.intent.operation.clone(),
            resource: input.intent.resource.clone(),
            audience: input.intent.audience.clone(),
            parameters: input.parameters.clone(),
            parameters_digest: input.intent.normalized_parameters_hash.clone(),
            authorized_operation: input.intent.operation.clone(),
            invoke_level: Some(1),
            connection_ref: input.connection_policy_id.clone(),
        };
        let connection_policy_id = input.connection_policy_id.clone();
        let disclose_outcome = self.host.permits_outcome_disclosure(&connection_policy_id);
        self.invoke_with_mode(
            input,
            |binding| async move {
                self.host
                    .invoke_bound(&connection_policy_id, &request, &binding)
            },
            false,
            disclose_outcome,
            false,
        )
        .await
    }

    /// Return a prior receipt only after checking the current authorization
    /// and the exact request binding. Never start new provider work.
    ///
    /// # Errors
    ///
    /// Returns an error when authorization fails or no matching receipt exists.
    pub async fn replay(&self, input: InvokeInput) -> anyhow::Result<InvocationReceipt> {
        self.invoke_with_mode(
            input,
            |_| async {
                Err(opensesame_connector_host::HostError::Connector(
                    "replay cannot execute".into(),
                ))
            },
            true,
            false,
            false,
        )
        .await
    }

    async fn invoke_with_mode<E, F>(
        &self,
        input: InvokeInput,
        execute: E,
        replay_only: bool,
        disclose_outcome: bool,
        reject_delegated: bool,
    ) -> anyhow::Result<InvocationReceipt>
    where
        E: FnOnce(InvocationBinding) -> F,
        F: std::future::Future<
            Output = Result<
                opensesame_connector_host::InvokeResult,
                opensesame_connector_host::HostError,
            >,
        >,
    {
        let now = Utc::now();
        input.intent.assert_fresh(now)?;
        input.grant.assert_active(now)?;

        if input.intent.organization_id != input.grant.organization_id {
            return Err(DomainError::OrganizationMismatch.into());
        }

        if !self.db.authority_quorum_ok().await? {
            return Err(
                DomainError::AuthorityUnavailable(AvailabilityClass::A3ExternalSideEffect).into(),
            );
        }

        let expected = Intent::parameters_hash(&input.parameters)?;
        if expected != input.intent.normalized_parameters_hash {
            anyhow::bail!("parameter digest mismatch");
        }
        let fingerprint = idempotency::legacy_fingerprint(&input)?;

        let authz_req = AuthZenRequest {
            subject: AuthZenSubject {
                type_: "user".into(),
                id: input.subject.clone(),
                properties: json!({"assurance": input.grant.constraints.required_assurance}),
            },
            action: AuthZenAction {
                name: input.intent.operation.clone(),
            },
            resource: AuthZenResource {
                type_: "connector_operation".into(),
                id: input.intent.resource.clone(),
            },
            context: json!({
                "connection_id": input.connection_policy_id,
                // The durable connection id, so a delegated child grant can be
                // its own eligibility for exactly the connection it names.
                "connection_uuid": input.intent.connection_id.map(|c| c.to_string()),
                "audience": input.intent.audience,
                "parameters_digest": input.intent.normalized_parameters_hash,
            }),
        };

        let decision = self.policy.decide(
            &authz_req,
            Some(&input.grant),
            input.lineage.as_ref(),
            AvailabilityClass::A3ExternalSideEffect,
        )?;
        if let Some(receipt) = self
            .prior_receipt(&input.intent, &fingerprint, None)
            .await?
        {
            anyhow::ensure!(
                decision.decision,
                "idempotency conflict: current authorization denied"
            );
            return Ok(receipt);
        }
        anyhow::ensure!(
            !replay_only,
            "idempotency conflict: no prior invocation to replay"
        );
        let mut inv = Self::begin_invocation(input.intent.id, now)?;
        let authority = if decision.decision {
            Some(InvocationBinding::from_intent(
                inv.id,
                &input.intent,
                &input.grant,
                &input.subject,
                &input.connection_policy_id,
                input.lineage.as_ref(),
            )?)
        } else {
            None
        };
        if let Some(auth) = authority.as_ref() {
            if reject_delegated && auth.is_delegated() {
                return Err(
                    opensesame_connector_host::HostError::DelegatedExecutionUnavailable.into(),
                );
            }
        }
        self.db
            .insert_bound_intent(&input.intent, &fingerprint)
            .await?;
        if !decision.decision {
            inv.transition(InvocationState::Denied, Utc::now())?;
            let receipt = self.finish_receipt(
                &input,
                &inv,
                FinishReceiptParts {
                    decision_id: &decision.decision_id,
                    policy_digest: &decision.policy_version_digest,
                    outcome: ReceiptOutcome::Denied,
                    binding: fingerprint.digest(),
                    connector_digest: self.host.component_digest(&input.connection_policy_id),
                    delegation_chain: opensesame_domain::receipt_delegation_chain(
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

        self.execute_authorized(
            &input,
            (
                inv,
                authority.ok_or_else(|| anyhow::anyhow!("missing invocation context"))?,
            ),
            &decision.decision_id,
            &decision.policy_version_digest,
            fingerprint.digest(),
            execute,
            disclose_outcome,
        )
        .await
    }

    async fn execute_authorized<E, F>(
        &self,
        input: &InvokeInput,
        invocation: (Invocation, InvocationBinding),
        decision_id: &str,
        policy_digest: &str,
        binding: &str,
        execute: E,
        disclose_outcome: bool,
    ) -> anyhow::Result<InvocationReceipt>
    where
        E: FnOnce(InvocationBinding) -> F,
        F: std::future::Future<
            Output = Result<
                opensesame_connector_host::InvokeResult,
                opensesame_connector_host::HostError,
            >,
        >,
    {
        let (mut invocation, authority) = invocation;
        invocation.transition(InvocationState::Authorized, Utc::now())?;
        invocation.transition(InvocationState::Leased, Utc::now())?;
        invocation.lease_owner = Some("worker-local".into());
        invocation.transition(InvocationState::Executing, Utc::now())?;
        self.db.insert_invocation(&invocation).await?;

        let result = execute(authority).await;

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
        let outcome = if disclose_outcome {
            outcome
        } else {
            ReceiptOutcome::Indeterminate
        };

        let receipt = self.finish_receipt(
            input,
            &invocation,
            FinishReceiptParts {
                decision_id,
                policy_digest,
                outcome,
                binding,
                connector_digest: self.host.component_digest(&input.connection_policy_id),
                delegation_chain: opensesame_domain::receipt_delegation_chain(
                    &input.grant,
                    input.lineage.as_ref(),
                ),
            },
        )?;
        // Retain the existing leak check as a defense if the receipt contract
        // evolves; schema 6 currently permits no result summary at all.
        if !receipt.assert_no_secret_leak() {
            anyhow::bail!("receipt summary rejected by secret-leak check");
        }
        self.db
            .finish_executing_invocation(&invocation, &receipt)
            .await?;
        Ok(receipt)
    }

    fn finish_receipt(
        &self,
        input: &InvokeInput,
        inv: &Invocation,
        parts: FinishReceiptParts<'_>,
    ) -> anyhow::Result<InvocationReceipt> {
        let receipt = InvocationReceipt {
            id: ReceiptId::new(),
            invocation_id: inv.id,
            intent_digest: self
                .signer
                .intent_commitment(&inv.id, &input.intent.digest()?)?,
            idempotency_binding: Some(self.signer.idempotency_commitment(parts.binding)),
            principal_id: input.intent.principal_id,
            organization_id: Some(input.intent.organization_id),
            actor_id: input.intent.actor_id,
            actor_instance_id: input.intent.actor_instance_id,
            client_id: input.intent.client_id,
            operator_id: input.intent.operator_id,
            delegation_chain: parts.delegation_chain,
            connection_id: input.intent.connection_id,
            operation: input.intent.operation.clone(),
            resource: input.intent.resource.clone(),
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
            task_run_id: None,
            task_state_version: None,
            task_state_digest: None,
        };
        Ok(self.signer.sign_receipt(receipt)?)
    }
}

pub(crate) struct FinishReceiptParts<'a> {
    decision_id: &'a str,
    policy_digest: &'a str,
    outcome: ReceiptOutcome,
    binding: &'a str,
    connector_digest: Option<&'a str>,
    delegation_chain: Vec<opensesame_domain::GrantId>,
}
