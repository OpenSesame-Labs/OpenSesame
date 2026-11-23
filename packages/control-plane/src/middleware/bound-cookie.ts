import { createHash, timingSafeEqual } from "node:crypto";
import type { AppContext } from "../context.js";

/** A proof is specific to one server session and never exposes the cookie. */
export async function boundCookieMatches(
  ctx: AppContext,
  sessionId: string,
  proof: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/u.test(proof)) return false;
  const session = await ctx.stores.provisionalSessions.get(sessionId);
  if (
    !session ||
    session.revokedAt ||
    session.revocationCleanupPending ||
    session.expiresAt <= ctx.clock() ||
    !session.restoreProofHash ||
    !/^[0-9a-f]{64}$/u.test(session.restoreProofHash)
  )
    return false;
  if (
    await ctx.stores.organizationMemberships.hasPendingWithdrawalForPrincipal(
      session.principalId,
    )
  )
    return false;
  const supplied = createHash("sha256").update(proof).digest();
  return timingSafeEqual(
    supplied,
    Buffer.from(session.restoreProofHash, "hex"),
  );
}
