//! Atomic settlement of a broker invocation and its signed receipt.

use anyhow::{bail, ensure};
use opensesame_domain::{Invocation, InvocationReceipt, InvocationState, ReceiptOutcome};
use sqlx::{Row, Sqlite, Transaction};

use crate::{sealed, Db};

fn validate_pair(invocation: &Invocation, receipt: &InvocationReceipt) -> anyhow::Result<()> {
    ensure!(
        invocation.id == receipt.invocation_id,
        "receipt and invocation do not match"
    );
    let outcome = match invocation.state {
        InvocationState::Succeeded => ReceiptOutcome::Succeeded,
        InvocationState::Failed => ReceiptOutcome::Failed,
        InvocationState::Denied => ReceiptOutcome::Denied,
        InvocationState::Cancelled => ReceiptOutcome::Cancelled,
        _ => bail!("invocation is not terminal"),
    };
    ensure!(
        receipt.outcome == outcome
            || (receipt.outcome == ReceiptOutcome::Indeterminate
                && matches!(
                    invocation.state,
                    InvocationState::Succeeded | InvocationState::Failed
                )
                && receipt.has_opaque_result()),
        "receipt outcome does not match invocation"
    );
    receipt.assert_schema_invariants()?;
    Ok(())
}

fn validate_organization(receipt: &InvocationReceipt, organization: &str) -> anyhow::Result<()> {
    ensure!(
        receipt
            .organization_id
            .is_some_and(|id| id.to_string() == organization),
        "receipt organization does not match invocation"
    );
    Ok(())
}

async fn insert_receipt(
    tx: &mut Transaction<'_, Sqlite>,
    organization: &str,
    receipt: &InvocationReceipt,
) -> anyhow::Result<()> {
    let body = sealed::seal_in(
        organization,
        "receipts.body_json",
        &receipt.id.to_string(),
        &serde_json::to_string(receipt)?,
    );
    sqlx::query(
        "INSERT INTO receipts (id, invocation_id, body_json, signature, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(receipt.id.to_string())
    .bind(receipt.invocation_id.to_string())
    .bind(body)
    .bind(&receipt.signature)
    .bind(receipt.completed_at.to_rfc3339())
    .execute(&mut **tx)
    .await?;
    Ok(())
}

impl Db {
    /// Transition one executing invocation and persist its receipt together.
    /// A failed transaction leaves the invocation executing with no receipt;
    /// the existing idempotency reservation must not be executed again.
    ///
    /// # Errors
    ///
    /// Returns an error when the pair, organization, stored state, or write
    /// is invalid, or another completion has already won.
    pub async fn finish_executing_invocation(
        &self,
        invocation: &Invocation,
        receipt: &InvocationReceipt,
    ) -> anyhow::Result<()> {
        validate_pair(invocation, receipt)?;
        ensure!(
            matches!(
                invocation.state,
                InvocationState::Succeeded | InvocationState::Failed | InvocationState::Cancelled
            ),
            "an executing invocation cannot settle as denied"
        );
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT i.organization_id, v.body_json, v.state FROM invocations v JOIN intents i ON i.id = v.intent_id WHERE v.id = ? AND v.intent_id = ?",
        )
        .bind(invocation.id.to_string())
        .bind(invocation.intent_id.to_string())
        .fetch_one(&mut *tx)
        .await?;
        let organization: String = row.get("organization_id");
        validate_organization(receipt, &organization)?;
        ensure!(
            row.get::<String, _>("state") == "executing",
            "invocation is not executing"
        );
        let old_body: String = row.get("body_json");
        let plaintext = sealed::open_in(
            &organization,
            "invocations.body_json",
            &invocation.id.to_string(),
            &old_body,
        )?;
        let mut expected: Invocation = serde_json::from_str(&plaintext)?;
        ensure!(
            expected.state == InvocationState::Executing,
            "sealed invocation is not executing"
        );
        expected.transition(invocation.state, invocation.updated_at)?;
        ensure!(
            &expected == invocation,
            "invocation changed beyond its terminal transition"
        );
        let new_body = sealed::seal_in(
            &organization,
            "invocations.body_json",
            &invocation.id.to_string(),
            &serde_json::to_string(invocation)?,
        );
        let updated = sqlx::query(
            "UPDATE invocations SET state = ?, body_json = ?, updated_at = ? WHERE id = ? AND intent_id = ? AND state = 'executing' AND body_json = ?",
        )
        .bind(format!("{:?}", invocation.state).to_lowercase())
        .bind(new_body)
        .bind(invocation.updated_at.to_rfc3339())
        .bind(invocation.id.to_string())
        .bind(invocation.intent_id.to_string())
        .bind(old_body)
        .execute(&mut *tx)
        .await?;
        ensure!(
            updated.rows_affected() == 1,
            "invocation changed while settling"
        );
        insert_receipt(&mut tx, &organization, receipt).await?;
        tx.commit().await?;
        Ok(())
    }

    /// Persist a pre-execution denial and its signed receipt together.
    ///
    /// # Errors
    ///
    /// Returns an error if the pair or its organization is invalid, or if
    /// either insert fails.
    pub async fn insert_denied_invocation_with_receipt(
        &self,
        invocation: &Invocation,
        receipt: &InvocationReceipt,
    ) -> anyhow::Result<()> {
        validate_pair(invocation, receipt)?;
        ensure!(
            invocation.state == InvocationState::Denied,
            "invocation is not denied"
        );
        let mut tx = self.pool.begin().await?;
        let organization: String =
            sqlx::query_scalar("SELECT organization_id FROM intents WHERE id = ?")
                .bind(invocation.intent_id.to_string())
                .fetch_one(&mut *tx)
                .await?;
        validate_organization(receipt, &organization)?;
        let body = sealed::seal_in(
            &organization,
            "invocations.body_json",
            &invocation.id.to_string(),
            &serde_json::to_string(invocation)?,
        );
        sqlx::query(
            "INSERT INTO invocations (id, intent_id, state, attempt, lease_owner, lease_expires_at, body_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(invocation.id.to_string())
        .bind(invocation.intent_id.to_string())
        .bind("denied")
        .bind(i64::from(invocation.attempt))
        .bind(&invocation.lease_owner)
        .bind(invocation.lease_expires_at.map(|time| time.to_rfc3339()))
        .bind(body)
        .bind(invocation.created_at.to_rfc3339())
        .bind(invocation.updated_at.to_rfc3339())
        .execute(&mut *tx)
        .await?;
        insert_receipt(&mut tx, &organization, receipt).await?;
        tx.commit().await?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "invocations_finish_tests.rs"]
mod tests;
