import { ConflictError, type UnitOfWork } from "@opensesame/database";
import type { Principal } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";

/**
 * Whether the principal a verified identity belongs to may be signed in as,
 * promoting a leftover provisional record first.
 *
 * A verified tuple can outlive the promotion that was supposed to follow
 * its creation (a crash or a lost update race between the two writes).
 * The assertion that just verified is the same proof the original attach
 * would have promoted on, so a returning sign-in finishes that promotion
 * instead of either signing in as a provisional principal or stranding a
 * verified owner forever. Suspended, closed and missing principals are
 * never promoted or admitted.
 */
export async function ensureVerifiedIdentityPrincipal(
  ctx: AppContext,
  principalId: string,
  uow?: UnitOfWork,
): Promise<Principal | null> {
  const principal = await ctx.repos.principals.getById(principalId, uow);
  if (
    !principal ||
    principal.state === "suspended" ||
    principal.state === "closed"
  ) {
    return null;
  }
  if (
    principal.state !== "provisional" &&
    principal.assurance !== "provisional"
  ) {
    return principal.state === "active" ? principal : null;
  }
  const now = ctx.clock();
  try {
    const updated = await ctx.repos.principals.update(
      principalId,
      {
        state: "active",
        assurance: "verified",
        verifiedAt: now,
        updatedAt: now,
      },
      principal.version,
      uow,
    );
    return updated.state === "active" && updated.assurance !== "provisional"
      ? updated
      : null;
  } catch (err) {
    if (err instanceof ConflictError) {
      const current = await ctx.repos.principals.getById(principalId, uow);
      return current?.state === "active" && current.assurance !== "provisional"
        ? current
        : null;
    }
    throw err;
  }
}

export async function settleVerifiedOwner(
  ctx: AppContext,
  principalId: string,
  uow?: UnitOfWork,
): Promise<boolean> {
  return (
    (await ensureVerifiedIdentityPrincipal(ctx, principalId, uow)) !== null
  );
}
