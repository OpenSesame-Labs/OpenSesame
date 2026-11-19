import { appendAuditEvent } from "@opensesame/audit";
import type { AppContext } from "../context.js";
import type { OrganizationWithdrawalAuditIntent } from "../repos/organization-withdrawal-audit.js";
import {
  advancePrincipalSessionEpoch,
  advancePrincipalSessionEpochOn,
  withPrincipalSessionBoundary,
} from "../repos/principal-session-boundary.js";

export type OrganizationRevocationInput = {
  organizationId: string;
  principalId: string;
  correlationId: string;
  reason: string;
  advanceEpochWithoutMembership?: boolean;
  expectedIncarnation?: string;
  expectedWithdrawalId?: string;
  withdrawalAudit?: OrganizationWithdrawalAuditIntent;
};

export type OrganizationRevocationResult = {
  membershipRemoved: boolean;
};

export async function revokeOrganizationMembership(
  ctx: AppContext,
  input: OrganizationRevocationInput,
): Promise<OrganizationRevocationResult> {
  const result = await withPrincipalSessionBoundary(
    ctx.stores,
    input.principalId,
    "revoke",
    async (stores, database) => {
      const membershipRemoved = input.expectedIncarnation
        ? await stores.organizationMemberships.removeIfIncarnation(
            input.organizationId,
            input.principalId,
            input.expectedIncarnation,
            input.expectedWithdrawalId,
          )
        : await stores.organizationMemberships.remove(
            input.organizationId,
            input.principalId,
          );
      if (membershipRemoved || input.advanceEpochWithoutMembership) {
        if (database)
          await advancePrincipalSessionEpochOn(database, input.principalId);
        else await advancePrincipalSessionEpoch(stores, input.principalId);
      }
      if (membershipRemoved && input.withdrawalAudit)
        await stores.organizationWithdrawalAudits.set(
          input.withdrawalAudit.id,
          input.withdrawalAudit,
        );
      return { membershipRemoved };
    },
  );
  if (!input.withdrawalAudit) {
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "organization.member_revoked",
      outcome: "succeeded",
      principalId: input.principalId,
      organizationId: input.organizationId,
      correlationId: input.correlationId,
      metadata: {
        action: "organization.member.revoke",
        reason: input.reason,
      },
    });
  }
  return result;
}
