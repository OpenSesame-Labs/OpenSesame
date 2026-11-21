//! Durable, request-bound ownership of invocation budget spends.
//!
//! The claim and delegation decrement share one SQLite write transaction. A
//! concurrent or restarted caller can recognize the same request, but cannot
//! take or release another request's hold. Only a known pre-dispatch abort may
//! delete the claim and refund a delegation unit.

use std::collections::BTreeMap;

use sqlx::Row;

use crate::delegation::BUDGET_INVOCATIONS;
use crate::{BrokerError, ConnectionBroker, Result};

/// Admission against the durable invocation budget claim.
#[derive(Debug, PartialEq, Eq)]
pub enum InvokeBudgetClaim {
    /// The caller owns the claim and any delegation unit it reserved.
    Reserved { claim_id: String },
    /// The same request already owns this key; it must not spend again.
    Duplicate,
    /// The key is already bound to another request or delegation.
    Conflict,
}

impl ConnectionBroker {
    /// Atomically bind an invocation key and spend its delegation unit.
    ///
    /// # Errors
    ///
    /// Returns an error for an exhausted, absent or malformed delegation, or
    /// if the transaction cannot be committed.
    pub async fn claim_invoke_budget(
        &self,
        organization_id: &str,
        idempotency_key: &str,
        fingerprint: &str,
        delegation_id: Option<&str>,
    ) -> Result<InvokeBudgetClaim> {
        let claim_id = uuid::Uuid::new_v4().to_string();
        let mut tx = self.pool.begin().await?;
        let inserted = sqlx::query(
            "INSERT OR IGNORE INTO invocation_budget_claims \
             (organization_id, idempotency_key, fingerprint, claim_id, delegation_id, budget_key, charged, created_at) \
             VALUES (?, ?, ?, ?, ?, NULL, 0, ?)",
        )
        .bind(organization_id)
        .bind(idempotency_key)
        .bind(fingerprint)
        .bind(&claim_id)
        .bind(delegation_id)
        .bind(opensesame_time::Utc::now().to_rfc3339())
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if inserted == 0 {
            let row = sqlx::query(
                "SELECT fingerprint, delegation_id FROM invocation_budget_claims \
                 WHERE organization_id = ? AND idempotency_key = ?",
            )
            .bind(organization_id)
            .bind(idempotency_key)
            .fetch_one(&mut *tx)
            .await?;
            return Ok(
                if row.get::<String, _>("fingerprint") == fingerprint
                    && row.get::<Option<String>, _>("delegation_id").as_deref() == delegation_id
                {
                    InvokeBudgetClaim::Duplicate
                } else {
                    InvokeBudgetClaim::Conflict
                },
            );
        }

        if let Some(delegation_id) = delegation_id {
            let row = sqlx::query(
                "SELECT budget_remaining FROM connection_delegations \
                 WHERE id = ? AND organization_id = ?",
            )
            .bind(delegation_id)
            .bind(organization_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(BrokerError::ConnectionNotFound)?;
            // Fail closed on a delegation that carries no readable budget: a
            // NULL column or a budget map without `invocations` refuses the
            // claim exactly like an exhausted one, rather than spending a
            // unit nobody decremented.
            let serialized = row
                .get::<Option<String>, _>("budget_remaining")
                .ok_or_else(|| BrokerError::Invalid("delegation budget missing".into()))?;
            let mut budgets: BTreeMap<String, i64> = serde_json::from_str(&serialized)?;
            let remaining = budgets
                .get_mut(BUDGET_INVOCATIONS)
                .ok_or_else(|| BrokerError::Invalid("budget exhausted: invocations".into()))?;
            if *remaining <= 0 {
                return Err(BrokerError::Invalid("budget exhausted: invocations".into()));
            }
            *remaining -= 1;
            sqlx::query("UPDATE connection_delegations SET budget_remaining = ? WHERE id = ?")
                .bind(serde_json::to_string(&budgets)?)
                .bind(delegation_id)
                .execute(&mut *tx)
                .await?;
            sqlx::query(
                "UPDATE invocation_budget_claims SET charged = 1, budget_key = ? WHERE claim_id = ?",
            )
            .bind(BUDGET_INVOCATIONS)
            .bind(&claim_id)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(InvokeBudgetClaim::Reserved { claim_id })
    }

    /// Refund only this claim's delegation unit after a known pre-dispatch abort.
    ///
    /// # Errors
    ///
    /// Returns an error if the persisted claim or budget cannot be restored.
    pub async fn release_invoke_budget_claim(
        &self,
        organization_id: &str,
        claim_id: &str,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        // Obtain the write lock before reading, so two releases cannot refund
        // the same unit or race a new claimant.
        let locked = sqlx::query(
            "UPDATE invocation_budget_claims SET claim_id = claim_id \
             WHERE organization_id = ? AND claim_id = ?",
        )
        .bind(organization_id)
        .bind(claim_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if locked == 0 {
            return Ok(());
        }
        let row = sqlx::query(
            "SELECT delegation_id, budget_key, charged FROM invocation_budget_claims \
             WHERE organization_id = ? AND claim_id = ?",
        )
        .bind(organization_id)
        .bind(claim_id)
        .fetch_one(&mut *tx)
        .await?;
        if row.get::<i64, _>("charged") == 1 {
            let delegation_id: String = row.try_get("delegation_id")?;
            let budget_key: String = row.try_get("budget_key")?;
            let serialized: String = sqlx::query_scalar(
                "SELECT budget_remaining FROM connection_delegations WHERE id = ? AND organization_id = ?",
            )
            .bind(&delegation_id)
            .bind(organization_id)
            .fetch_one(&mut *tx)
            .await?;
            let mut budgets: BTreeMap<String, i64> = serde_json::from_str(&serialized)?;
            let remaining = budgets
                .get_mut(&budget_key)
                .ok_or_else(|| BrokerError::Invalid("delegation budget missing".into()))?;
            *remaining = remaining
                .checked_add(1)
                .ok_or_else(|| BrokerError::Invalid("delegation budget overflow".into()))?;
            sqlx::query("UPDATE connection_delegations SET budget_remaining = ? WHERE id = ?")
                .bind(serde_json::to_string(&budgets)?)
                .bind(delegation_id)
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query(
            "DELETE FROM invocation_budget_claims WHERE organization_id = ? AND claim_id = ?",
        )
        .bind(organization_id)
        .bind(claim_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "delegation_invoke_budget_tests.rs"]
mod tests;
