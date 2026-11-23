use crate::{DomainError, IntentId, InvocationId};
use opensesame_time::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InvocationState {
    Received,
    Authorizing,
    AwaitingApproval,
    Authorized,
    Leased,
    Executing,
    Succeeded,
    Failed,
    Denied,
    Cancelled,
    Expired,
}

impl InvocationState {
    /// Stable column value persisted in `invocations.state` (snake_case, not `Debug`).
    #[must_use]
    pub const fn as_sql_value(self) -> &'static str {
        match self {
            Self::Received => "received",
            Self::Authorizing => "authorizing",
            Self::AwaitingApproval => "awaiting_approval",
            Self::Authorized => "authorized",
            Self::Leased => "leased",
            Self::Executing => "executing",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Denied => "denied",
            Self::Cancelled => "cancelled",
            Self::Expired => "expired",
        }
    }

    #[must_use]
    pub fn can_transition(self, to: Self) -> bool {
        use InvocationState::{
            Authorized, Authorizing, AwaitingApproval, Cancelled, Denied, Executing, Expired,
            Failed, Leased, Received, Succeeded,
        };
        matches!(
            (self, to),
            (Received, Authorizing | Expired)
                | (
                    Authorizing,
                    AwaitingApproval | Authorized | Denied | Expired
                )
                | (AwaitingApproval | Leased, Authorized)
                | (AwaitingApproval, Denied | Cancelled | Expired)
                | (Authorized, Leased | Cancelled | Expired)
                | (Leased, Executing | Expired)
                | (Executing, Succeeded | Failed | Cancelled)
        )
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Invocation {
    pub id: InvocationId,
    pub intent_id: IntentId,
    pub state: InvocationState,
    pub attempt: u32,
    pub lease_owner: Option<String>,
    pub lease_expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Invocation {
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn transition(
        &mut self,
        to: InvocationState,
        now: DateTime<Utc>,
    ) -> Result<(), DomainError> {
        if !self.state.can_transition(to) {
            return Err(DomainError::InvalidTransition {
                from: format!("{:?}", self.state),
                to: format!("{to:?}"),
            });
        }
        self.state = to;
        self.updated_at = now;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sql_values_are_stable_snake_case() {
        assert_eq!(
            InvocationState::AwaitingApproval.as_sql_value(),
            "awaiting_approval"
        );
        assert_ne!(
            InvocationState::AwaitingApproval.as_sql_value(),
            format!("{:?}", InvocationState::AwaitingApproval).to_lowercase()
        );
    }

    #[test]
    fn happy_path_transitions() {
        assert!(InvocationState::Received.can_transition(InvocationState::Authorizing));
        assert!(InvocationState::Executing.can_transition(InvocationState::Succeeded));
        assert!(!InvocationState::Succeeded.can_transition(InvocationState::Executing));
    }
}
