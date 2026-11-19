import { appendAuditEvent } from "@opensesame/audit";
import type { AppContext } from "../context.js";
import type { OrganizationWithdrawalAuditIntent } from "../repos/organization-withdrawal-audit.js";
import {
  advancePrincipalSessionEpoch,
  advancePrincipalSessionEpochOn,
  withPrincipalSessionBoundary,
} from "../repos/principal-session-boundary.js";
import { removeOrphanTokens } from "../repos/session-storage.js";

export type OrganizationRevocationInput = {
  organizationId: string;
  principalId: string;
  correlationId: string;
  reason: string;
  revokeSessionsWithoutMembership?: boolean;
  membershipSerialized?: boolean;
  expectedIncarnation?: string;
  expectedWithdrawalId?: string;
  withdrawalAudit?: OrganizationWithdrawalAuditIntent;
};

export type OrganizationRevocationResult = {
  membershipRemoved: boolean;
  sessionsRevoked: number;
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
      if (membershipRemoved || input.revokeSessionsWithoutMembership) {
        if (database)
          await advancePrincipalSessionEpochOn(database, input.principalId);
        else await advancePrincipalSessionEpoch(stores, input.principalId);
      }
      let sessionsRevoked = 0;
      if (membershipRemoved || input.revokeSessionsWithoutMembership) {
        for (const [, session] of await stores.provisionalSessions.entries()) {
          if (session.principalId !== input.principalId) continue;
          await stores.provisionalSessions.delete(session.id);
          sessionsRevoked += 1;
        }
      }
      await removeOrphanTokens(stores);
      return { membershipRemoved, sessionsRevoked };
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
        count: result.sessionsRevoked,
      },
    });
  }
  return result;
}
