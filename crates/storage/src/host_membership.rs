//! Durable fences for Identity membership revisions and associated browser authority.
use crate::Db;
use sqlx::Row;

/// The exact membership authority that Identity has withdrawn.
pub struct MembershipWithdrawal<'a> {
    pub withdrawal_id: &'a str,
    pub organization_id: &'a str,
    pub principal_id: &'a str,
    pub membership_incarnation: &'a str,
    pub authority_revision: &'a str,
}

impl Db {
    /// Record the fence and revoke browser authority in one transaction.
    /// A repeated withdrawal cannot affect a later revision.
    /// # Errors
    /// A reused withdrawal id with different contents or any storage error fails closed.
    pub async fn withdraw_host_membership(
        &self,
        input: &MembershipWithdrawal<'_>,
        now: i64,
    ) -> anyhow::Result<bool> {
        self.withdraw_host_membership_with_count(input, now)
            .await
            .map(|(inserted, _)| inserted)
    }

    /// Withdraw one revision and return the number of native sessions revoked.
    /// The durable fence, pending grants, and sessions change in one write transaction.
    /// # Errors
    /// A reused withdrawal id with different contents or any storage error fails closed.
    pub async fn withdraw_host_membership_with_count(
        &self,
        input: &MembershipWithdrawal<'_>,
        now: i64,
    ) -> anyhow::Result<(bool, u64)> {
        let mut tx = self.pool().begin_with("BEGIN IMMEDIATE").await?;
        let inserted = sqlx::query(
            "INSERT INTO host_membership_withdrawals
            (withdrawal_id,organization_id,principal_id,membership_incarnation,authority_revision)
            VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING",
        )
        .bind(input.withdrawal_id)
        .bind(input.organization_id)
        .bind(input.principal_id)
        .bind(input.membership_incarnation)
        .bind(input.authority_revision)
        .execute(&mut *tx)
        .await?
        .rows_affected()
            == 1;
        if !inserted {
            let existing = sqlx::query(
                "SELECT organization_id,principal_id,membership_incarnation,authority_revision
                FROM host_membership_withdrawals WHERE withdrawal_id=?",
            )
            .bind(input.withdrawal_id)
            .fetch_optional(&mut *tx)
            .await?;
            if let Some(row) = existing {
                anyhow::ensure!(
                    row.try_get::<String, _>("organization_id")? == input.organization_id
                        && row.try_get::<String, _>("principal_id")? == input.principal_id
                        && row.try_get::<String, _>("membership_incarnation")?
                            == input.membership_incarnation
                        && row.try_get::<String, _>("authority_revision")?
                            == input.authority_revision,
                    "withdrawal id conflict"
                );
            } else {
                anyhow::bail!("membership revision already fenced by another withdrawal id");
            }
            tx.commit().await?;
            return Ok((false, 0));
        }

        // Legacy approvals predate Identity evidence and must be cleared once.
        // Revision-bound pairings for a later membership remain untouched.
        sqlx::query(
            "UPDATE browser_pairings SET state='denied'
            WHERE organization_id=? AND principal_id=? AND state='approved'
            AND ((membership_incarnation=? AND authority_revision=?)
                 OR (membership_incarnation IS NULL AND authority_revision IS NULL))",
        )
        .bind(input.organization_id)
        .bind(input.principal_id)
        .bind(input.membership_incarnation)
        .bind(input.authority_revision)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE browser_clients SET revoked_at=?
            WHERE organization_id=? AND principal_id=? AND revoked_at IS NULL
            AND ((membership_incarnation=? AND authority_revision=?)
                 OR (membership_incarnation IS NULL AND authority_revision IS NULL))",
        )
        .bind(now)
        .bind(input.organization_id)
        .bind(input.principal_id)
        .bind(input.membership_incarnation)
        .bind(input.authority_revision)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE agent_launches SET revoked=1
            WHERE organization_id=? AND principal_id=? AND revoked=0
            AND ((membership_incarnation=? AND authority_revision=?)
                 OR (membership_incarnation IS NULL AND authority_revision IS NULL))",
        )
        .bind(input.organization_id)
        .bind(input.principal_id)
        .bind(input.membership_incarnation)
        .bind(input.authority_revision)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "DELETE FROM host_membership_current WHERE organization_id=? AND principal_id=?
            AND membership_incarnation=? AND authority_revision=?",
        )
        .bind(input.organization_id)
        .bind(input.principal_id)
        .bind(input.membership_incarnation)
        .bind(input.authority_revision)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM host_authorizations WHERE client_id IN (
            SELECT id FROM browser_clients WHERE organization_id=? AND principal_id=? AND revoked_at IS NOT NULL)")
            .bind(input.organization_id).bind(input.principal_id).execute(&mut *tx).await?;
        let native_revoked = sqlx::query(
            "DELETE FROM host_native_sessions
            WHERE organization_id=? AND principal_id=?
            AND ((membership_incarnation=? AND authority_revision=?)
                 OR (membership_incarnation IS NULL AND authority_revision IS NULL))",
        )
        .bind(input.organization_id)
        .bind(input.principal_id)
        .bind(input.membership_incarnation)
        .bind(input.authority_revision)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        sqlx::query("UPDATE host_device_codes SET approved_json=NULL,organization_id=NULL,principal_id=NULL,
            membership_incarnation=NULL,authority_revision=NULL
            WHERE organization_id=? AND principal_id=?
            AND ((membership_incarnation=? AND authority_revision=?)
                 OR (membership_incarnation IS NULL AND authority_revision IS NULL))")
            .bind(input.organization_id).bind(input.principal_id)
            .bind(input.membership_incarnation).bind(input.authority_revision)
            .execute(&mut *tx).await?;
        tx.commit().await?;
        Ok((true, native_revoked))
    }

    /// Record Identity-approved current authority, unless it was already withdrawn.
    /// # Errors
    /// Storage failure must be treated as denial.
    pub async fn activate_host_membership(
        &self,
        organization: &str,
        principal: &str,
        incarnation: &str,
        revision: &str,
    ) -> anyhow::Result<bool> {
        let changed = sqlx::query("INSERT INTO host_membership_current
            (organization_id,principal_id,membership_incarnation,authority_revision)
            SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM host_membership_withdrawals
                WHERE organization_id=? AND principal_id=? AND membership_incarnation=? AND authority_revision=?)
            ON CONFLICT(organization_id,principal_id) DO UPDATE SET
              membership_incarnation=excluded.membership_incarnation,authority_revision=excluded.authority_revision")
            .bind(organization).bind(principal).bind(incarnation).bind(revision)
            .bind(organization).bind(principal).bind(incarnation).bind(revision)
            .execute(self.pool()).await?.rows_affected();
        Ok(changed == 1)
    }

    /// A missing revision denotes a legacy/local grant. Once a withdrawal exists,
    /// it cannot stand in for a particular Identity revision.
    /// # Errors
    /// Storage failures must be treated as denial.
    pub async fn host_membership_live(
        &self,
        organization: &str,
        principal: &str,
        revision: Option<(&str, &str)>,
    ) -> anyhow::Result<bool> {
        let row: i64 = match revision {
            Some((incarnation, revision)) => sqlx::query_scalar("SELECT COUNT(*) FROM host_membership_withdrawals
                WHERE organization_id=? AND principal_id=? AND membership_incarnation=? AND authority_revision=?")
                .bind(organization).bind(principal).bind(incarnation).bind(revision).fetch_one(self.pool()).await?,
            None => sqlx::query_scalar("SELECT COUNT(*) FROM host_membership_withdrawals
                WHERE organization_id=? AND principal_id=?")
                .bind(organization).bind(principal).fetch_one(self.pool()).await?,
        };
        Ok(row == 0)
    }
}
