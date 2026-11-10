import { agentAuthError } from "@opensesame/agent-protocols";
import type { Principal } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import { settleVerifiedOwner } from "./identity-principal-fence.js";

async function sessionMayClaim(
  ctx: AppContext,
  principal: Principal,
  expectedEmail?: string,
): Promise<boolean> {
  // Provisional in EITHER dimension is provisional: a half-promoted
  // record (active state, provisional assurance — or the reverse) owes
  // the same verified-email proof as a fully provisional one before it
  // may claim an agent. Gating on both let a half-promoted human with
  // no verified email at all complete an emailless claim.
  if (
    principal.assurance === "provisional" ||
    principal.state === "provisional"
  ) {
    const identities = await ctx.repos.externalIdentities.listByPrincipal(
      principal.id,
    );
    if (!identities.some((identity) => identity.emailVerified)) return false;
  }
  if (!expectedEmail) return true;
  const identities = await ctx.repos.externalIdentities.listByPrincipal(
    principal.id,
  );
  return identities.some(
    (identity) =>
      identity.emailVerified === true &&
      identity.emailNormalized === expectedEmail,
  );
}

/**
 * Whether this human may complete the claim, finishing a leftover
 * provisional record on the way.
 *
 * A leftover provisional human who just proved the claim (session + user
 * code + the verified email sessionMayClaim required) is finished here:
 * claimed tokens are minted for registration.principalId, which
 * claimAgentRegistration sets to this human, and a provisional human must
 * not be the principal claimed tokens act for. Promotion is owed only on
 * that verified-email proof, so it is checked, not assumed.
 */
export async function claimantAdmitted(
  ctx: AppContext,
  principal: Principal,
  expectedEmail?: string,
): Promise<boolean> {
  if (!(await sessionMayClaim(ctx, principal, expectedEmail))) return false;
  const identities = await ctx.repos.externalIdentities.listByPrincipal(
    principal.id,
  );
  if (!identities.some((identity) => identity.emailVerified)) return true;
  return settleVerifiedOwner(ctx, principal.id);
}

/**
 * Claimed tokens act for the claiming human, whom claimAgentRegistration
 * installs as registration.principalId. They are minted only for a
 * settled human — active state, non-provisional assurance. An agent
 * polling or exchanging must not promote anyone itself, so a legacy
 * half-promoted claimed registration refuses here until a human road
 * (federated sign-in, re-link, claim completion) finishes the promotion.
 * Unclaimed registrations keep loading their own by-design provisional
 * agent principal via loadPrincipal.
 */
export function assertClaimedPrincipalSettled(principal: Principal): void {
  if (principal.state !== "active" || principal.assurance === "provisional") {
    throw agentAuthError("invalid_grant", 400, "principal unavailable");
  }
}
