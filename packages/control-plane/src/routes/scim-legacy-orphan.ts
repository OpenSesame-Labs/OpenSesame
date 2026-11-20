import { appendAuditEvent } from "@opensesame/audit";
import type { AppContext } from "../context.js";
import { withScimOrganizationBoundary } from "../repos/scim-organization-boundary.js";
import { hostApiEndpoint } from "../services/host-endpoint.js";
import { confirmsDurableWithdrawal } from "../services/host-withdrawal-attestation.js";
import { revokeOrganizationMembership } from "./organization-revocation.js";

type LegacyOrphan = {
  principalId: string;
  incarnation: string;
  authorityRevision: string;
  withdrawalId: string;
};

export async function finishLegacyOrphan(
  ctx: AppContext,
  organizationId: string,
  orphan: LegacyOrphan,
  correlationId: string,
): Promise<void> {
  const url = hostApiEndpoint(ctx.config.hostApiUrl, "api/v1/sessions/revoke");
  if (!url) throw new Error("Host session revocation is unavailable");
  const cleaned = await withScimOrganizationBoundary(
    ctx,
    organizationId,
    async (tx) => {
      const recreated = await tx.stores.organizationMemberships.findVersioned(
        organizationId,
        orphan.principalId,
      );
      if (recreated) return false;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opensesame-operator": tx.config.operatorToken,
        },
        body: JSON.stringify({
          organization_id: organizationId,
          principal_id: orphan.principalId,
          membership_incarnation: orphan.incarnation,
          authority_revision: orphan.authorityRevision,
          withdrawal_id: orphan.withdrawalId,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      if (
        !(await confirmsDurableWithdrawal(response, {
          withdrawalId: orphan.withdrawalId,
          membershipIncarnation: orphan.incarnation,
          authorityRevision: orphan.authorityRevision,
        }))
      )
        throw new Error("Host session revocation is unavailable");
      await revokeOrganizationMembership(tx, {
        organizationId,
        principalId: orphan.principalId,
        correlationId,
        reason: "scim_deactivated",
        advanceEpochWithoutMembership: true,
        appendAudit: false,
      });
      return true;
    },
  );
  if (!cleaned) return;
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "organization.member_revoked",
    outcome: "succeeded",
    principalId: orphan.principalId,
    organizationId,
    correlationId,
    metadata: {
      action: "organization.member.revoke",
      reason: "scim_deactivated",
    },
  });
}
