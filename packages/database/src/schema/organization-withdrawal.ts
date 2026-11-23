import { sql } from "drizzle-orm";
import { type AnyPgColumn, check, index } from "drizzle-orm/pg-core";

interface WithdrawalColumns {
  principalId: AnyPgColumn;
  withdrawalId: AnyPgColumn;
  withdrawalKind: AnyPgColumn;
  withdrawalRole: AnyPgColumn;
  withdrawalReason: AnyPgColumn;
  withdrawalActorType: AnyPgColumn;
  withdrawalActorPrincipalId: AnyPgColumn;
  withdrawalCorrelationId: AnyPgColumn;
}

export function organizationWithdrawalIndexes(t: WithdrawalColumns) {
  return [
    index("organization_memberships_withdrawal_pending_idx")
      .on(t.withdrawalId)
      .where(sql`${t.withdrawalId} is not null`),
    index("organization_memberships_withdrawal_principal_idx")
      .on(t.principalId)
      .where(sql`${t.withdrawalId} is not null`),
  ];
}

export function organizationWithdrawalCheck(t: WithdrawalColumns) {
  return check(
    "organization_memberships_withdrawal_check",
    sql`(
      ${t.withdrawalId} is null and ${t.withdrawalKind} is null and
      ${t.withdrawalRole} is null and ${t.withdrawalReason} is null and ${t.withdrawalActorType} is null and
      ${t.withdrawalActorPrincipalId} is null and
      ${t.withdrawalCorrelationId} is null
    ) or (
      ${t.withdrawalId} is not null and ${t.withdrawalKind} is not null and
      ${t.withdrawalActorType} is not null and ${t.withdrawalActorType} in ('human','system') and
      ${t.withdrawalActorPrincipalId} is not null and ${t.withdrawalCorrelationId} is not null and
      ((${t.withdrawalKind} = 'remove' and ${t.withdrawalRole} is null and
        (${t.withdrawalReason} is null or ${t.withdrawalReason} in ('organization_owner_removed','scim_deactivated','ldap_directory_sync'))) or
       (${t.withdrawalKind} = 'change_role' and ${t.withdrawalRole} is not null and
        ${t.withdrawalRole} in ('owner','admin','member') and ${t.withdrawalReason} is null))
    )`,
  );
}
