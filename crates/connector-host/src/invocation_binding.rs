//! Invocation-local snapshots carried to host egress.
//!
//! These values bind a particular invocation and request; they are not an
//! authorization proof, a revocation fence, or a license to start an effect.
//! A future effect fence must independently check durable current authority.

use opensesame_domain::{
    ActorId, ConnectionId, FrozenIntentV2, Grant, GrantId, Intent, IntentId, InvocationId,
    OrganizationId, PrincipalId, ValidatedGrantChain,
};

use crate::{HostError, InvokeRequest};

#[derive(Clone)]
struct IntentSnapshot {
    id: IntentId,
    digest: String,
    frozen: bool,
    organization_id: OrganizationId,
    principal_id: PrincipalId,
    actor_id: ActorId,
    connection_id: Option<ConnectionId>,
    operation: String,
    resource: String,
    audience: String,
    parameters_digest: String,
    delegation_chain: Option<Vec<GrantId>>,
}

/// An immutable, process-local observation of the request selected by the broker.
///
/// This type intentionally has no wire format. Its public constructors check
/// consistency only: callers can supply their own inputs, and no constructor
/// proves policy approval, freshness, or current durable grant state.
#[derive(Clone)]
pub struct InvocationBinding {
    invocation_id: InvocationId,
    intent: IntentSnapshot,
    subject: String,
    connection_policy_id: String,
    grant: Grant,
    lineage: Option<ValidatedGrantChain>,
}

impl InvocationBinding {
    /// Capture a standard intent after its caller has performed admission.
    ///
    /// # Errors
    /// Returns an error for inconsistent intent, grant, or lineage snapshots.
    pub fn from_intent(
        invocation_id: InvocationId,
        intent: &Intent,
        grant: &Grant,
        subject: &str,
        connection_policy_id: &str,
        lineage: Option<&ValidatedGrantChain>,
    ) -> Result<Self, HostError> {
        let snapshot = IntentSnapshot {
            id: intent.id,
            digest: intent
                .digest()
                .map_err(|_| HostError::InvocationBindingMismatch)?,
            frozen: false,
            organization_id: intent.organization_id,
            principal_id: intent.principal_id,
            actor_id: intent.actor_id,
            connection_id: intent.connection_id,
            operation: intent.operation.clone(),
            resource: intent.resource.clone(),
            audience: intent.audience.clone(),
            parameters_digest: intent.normalized_parameters_hash.clone(),
            delegation_chain: Some(intent.delegation_chain.clone()),
        };
        Self::from_snapshot(
            invocation_id,
            snapshot,
            grant,
            subject,
            connection_policy_id,
            lineage,
        )
    }

    /// Capture a frozen intent, including its original task-bound digest.
    ///
    /// # Errors
    /// Returns an error for a modified digest or inconsistent authority snapshots.
    pub fn from_frozen(
        invocation_id: InvocationId,
        intent: &FrozenIntentV2,
        grant: &Grant,
        subject: &str,
        connection_policy_id: &str,
        lineage: Option<&ValidatedGrantChain>,
    ) -> Result<Self, HostError> {
        intent
            .assert_digest()
            .map_err(|_| HostError::InvocationBindingMismatch)?;
        let snapshot = IntentSnapshot {
            id: intent.id,
            digest: intent.intent_digest.clone(),
            frozen: true,
            organization_id: intent.organization_id,
            principal_id: intent.principal_id,
            actor_id: intent.actor_id,
            connection_id: intent.connection_id,
            operation: intent.operation.clone(),
            resource: intent.resource.clone(),
            audience: intent.audience.clone(),
            parameters_digest: Intent::parameters_hash(&intent.canonical_arguments)
                .map_err(|_| HostError::InvocationBindingMismatch)?,
            delegation_chain: None,
        };
        Self::from_snapshot(
            invocation_id,
            snapshot,
            grant,
            subject,
            connection_policy_id,
            lineage,
        )
    }

    fn from_snapshot(
        invocation_id: InvocationId,
        intent: IntentSnapshot,
        grant: &Grant,
        subject: &str,
        connection_policy_id: &str,
        lineage: Option<&ValidatedGrantChain>,
    ) -> Result<Self, HostError> {
        let delegated = grant.parent_grant_id.is_some() || grant.delegation_depth != 0;
        let valid_lineage = match lineage {
            Some(chain) => {
                chain.leaf() == grant && chain.establishes_delegated_eligibility() == delegated
            }
            None => !delegated,
        };
        let expected_chain = lineage.map_or_else(|| vec![grant.id], ValidatedGrantChain::grant_ids);
        let valid_chain = intent
            .delegation_chain
            .as_ref()
            .is_none_or(|ids| ids.is_empty() || ids == &expected_chain);
        if intent.organization_id != grant.organization_id
            || intent.principal_id != grant.beneficiary_principal_id
            || grant
                .connection_id
                .is_some_and(|id| intent.connection_id != Some(id))
            || subject.is_empty()
            || connection_policy_id.is_empty()
            || !valid_lineage
            || !valid_chain
        {
            return Err(HostError::InvocationBindingMismatch);
        }
        Ok(Self {
            invocation_id,
            intent,
            subject: subject.to_owned(),
            connection_policy_id: connection_policy_id.to_owned(),
            grant: grant.clone(),
            lineage: lineage.cloned(),
        })
    }

    /// Check that the actual connector dispatch is the captured request.
    ///
    /// # Errors
    /// Returns an error on any connection, scope, level, or parameter mismatch.
    pub fn assert_request(
        &self,
        policy_id: &str,
        request: &InvokeRequest,
    ) -> Result<(), HostError> {
        let actual_digest = Intent::parameters_hash(&request.parameters)
            .map_err(|_| HostError::InvocationBindingMismatch)?;
        if policy_id != self.connection_policy_id
            || request.connection_ref != self.connection_policy_id
            || request.operation != self.intent.operation
            || request.authorized_operation != self.intent.operation
            || request.resource != self.intent.resource
            || request.audience != self.intent.audience
            || request.invoke_level != Some(1)
            || request.parameters_digest != self.intent.parameters_digest
            || actual_digest != self.intent.parameters_digest
        {
            return Err(HostError::InvocationBindingMismatch);
        }
        Ok(())
    }

    #[must_use]
    pub fn invocation_id(&self) -> InvocationId {
        self.invocation_id
    }
    #[must_use]
    pub fn intent_id(&self) -> IntentId {
        self.intent.id
    }
    #[must_use]
    pub fn intent_digest(&self) -> &str {
        &self.intent.digest
    }
    #[must_use]
    pub fn is_frozen(&self) -> bool {
        self.intent.frozen
    }
    #[must_use]
    pub fn organization_id(&self) -> OrganizationId {
        self.intent.organization_id
    }
    #[must_use]
    pub fn principal_id(&self) -> PrincipalId {
        self.intent.principal_id
    }
    #[must_use]
    pub fn actor_id(&self) -> ActorId {
        self.intent.actor_id
    }
    #[must_use]
    pub fn connection_id(&self) -> Option<ConnectionId> {
        self.intent.connection_id
    }
    #[must_use]
    pub fn subject(&self) -> &str {
        &self.subject
    }
    #[must_use]
    pub fn connection_policy_id(&self) -> &str {
        &self.connection_policy_id
    }
    #[must_use]
    pub fn operation(&self) -> &str {
        &self.intent.operation
    }
    #[must_use]
    pub fn resource(&self) -> &str {
        &self.intent.resource
    }
    #[must_use]
    pub fn audience(&self) -> &str {
        &self.intent.audience
    }
    #[must_use]
    pub fn parameters_digest(&self) -> &str {
        &self.intent.parameters_digest
    }
    #[must_use]
    pub fn grant(&self) -> &Grant {
        &self.grant
    }
    #[must_use]
    pub fn lineage(&self) -> Option<&ValidatedGrantChain> {
        self.lineage.as_ref()
    }
    #[must_use]
    pub fn is_delegated(&self) -> bool {
        self.grant.parent_grant_id.is_some() || self.grant.delegation_depth != 0
    }
}

#[cfg(test)]
#[path = "invocation_binding_tests.rs"]
mod tests;
