import type { AppContext } from "../context.js";

/** Require an unrevoked, recently authenticated session for channel changes. */
export async function hasFreshAuthentication(
  ctx: AppContext,
  sessionId: string | undefined,
): Promise<boolean> {
  if (!sessionId) return false;
  const session = await ctx.stores.provisionalSessions.get(sessionId);
  if (
    !session ||
    session.revokedAt ||
    session.revocationCleanupPending ||
    session.expiresAt <= ctx.clock() ||
    (await ctx.stores.organizationMemberships.hasPendingWithdrawalForPrincipal(
      session.principalId,
    ))
  )
    return false;
  return ctx.clock().getTime() - session.createdAt.getTime() <= 900_000;
}
