import type { AppContext } from "../context.js";
import {
  beginProvisionalRevocation,
  finishProvisionalRevocation,
} from "../repos/provisional-revocation.js";
import { hostApiEndpoint } from "../services/host-endpoint.js";
import type { DeprovisionTarget } from "./scim-deprovision-journal.js";

/** Fence the exact sessions present when a deleted principal was discovered. */
export async function fenceLegacyOrphan(
  ctx: AppContext,
  organizationId: string,
  target: DeprovisionTarget,
  correlationId: string,
): Promise<void> {
  if (!target.legacyOrphan || target.completed) return;
  for (const sessionId of target.legacyOrphan.sessionIds) {
    await beginProvisionalRevocation(
      ctx,
      sessionId,
      {
        actorType: "system",
        correlationId,
        metadata: { organizationId, reason: "scim_deactivated" },
      },
      (session) =>
        session.principalId === target.principalId && !session.revokedAt,
    );
  }
}

/** Host fences the legacy organization/principal scope even without a principal row. */
export async function finishLegacyOrphan(
  ctx: AppContext,
  organizationId: string,
  target: DeprovisionTarget,
  correlationId: string,
): Promise<void> {
  const orphan = target.legacyOrphan;
  if (!orphan) throw new Error("Expected a legacy orphan withdrawal");
  await fenceLegacyOrphan(ctx, organizationId, target, correlationId);
  const url = hostApiEndpoint(ctx.config.hostApiUrl, "api/v1/sessions/revoke");
  if (!url) throw new Error("Host session revocation is unavailable");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opensesame-operator": ctx.config.operatorToken,
    },
    body: JSON.stringify({
      organization_id: organizationId,
      principal_id: target.principalId,
      membership_incarnation: target.incarnation,
      authority_revision: orphan.authorityRevision,
      withdrawal_id: orphan.withdrawalId,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error("Host session revocation is unavailable");
  for (const sessionId of orphan.sessionIds) {
    const session = await ctx.stores.provisionalSessions.get(sessionId);
    if (
      session?.principalId === target.principalId &&
      session.revocationCleanupPending
    )
      await finishProvisionalRevocation(ctx, sessionId);
  }
}
