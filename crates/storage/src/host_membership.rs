//! Durable fences for Identity membership revisions.
use crate::Db;
use sqlx::Row;

pub struct MembershipWithdrawal<'a> {
    pub withdrawal_id: &'a str,
    pub organization_id: &'a str,
    pub principal_id: &'a str,
    pub membership_incarnation: &'a str,
    pub authority_revision: &'a str,
}

impl Db {
    /// Record one exact Identity revision. Exact retries are idempotent; reusing
    /// an id for a different revision is rejected.
    pub async fn withdraw_host_membership(
        &self,
        input: &MembershipWithdrawal<'_>,
    ) -> anyhow::Result<bool> {
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
            let Some(row) = existing else {
                anyhow::bail!("membership revision already fenced by another withdrawal id");
            };
            anyhow::ensure!(
                row.try_get::<String, _>("organization_id")? == input.organization_id
                    && row.try_get::<String, _>("principal_id")? == input.principal_id
                    && row.try_get::<String, _>("membership_incarnation")?
                        == input.membership_incarnation
                    && row.try_get::<String, _>("authority_revision")? == input.authority_revision,
                "withdrawal id conflict"
            );
        }
        tx.commit().await?;
        Ok(inserted)
    }

    pub async fn host_membership_live(
        &self,
        organization: &str,
        principal: &str,
        incarnation: &str,
        revision: &str,
    ) -> anyhow::Result<bool> {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM host_membership_withdrawals
             WHERE organization_id=? AND principal_id=?
               AND membership_incarnation=? AND authority_revision=?",
        )
        .bind(organization)
        .bind(principal)
        .bind(incarnation)
        .bind(revision)
        .fetch_one(self.pool())
        .await?;
        Ok(count == 0)
    }
}
