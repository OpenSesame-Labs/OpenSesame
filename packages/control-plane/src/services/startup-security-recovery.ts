import type { AppContext } from "../context.js";
import { resumePendingUpstreamLogouts } from "../interactions/upstream-logout.js";
import { resumePendingOrganizationRevocationAudits } from "../repos/organization-revocation-audit.js";
import { resumePendingOrganizationWithdrawalAudits } from "../repos/organization-withdrawal-audit.js";
import { resumePendingProvisionalRevocations } from "../repos/provisional-revocation.js";
import { rekeyLegacySecurityRows } from "../repos/security-map-rekey.js";
import { prepareLegacyScimRecovery } from "./scim-deprovision-recovery.js";

/** Recover durable security work only after migration and sealing have finished. */
export async function recoverStartupSecurityState(
  ctx: AppContext,
): Promise<void> {
  await ctx.systemPrincipalReady;
  // Throws, failing startup closed, if a no-expiry security record remains
  // under its legacy id; the counts are expired-by-TTL bearers only.
  const legacyRows = await rekeyLegacySecurityRows(ctx.stores);
  if (Object.values(legacyRows).some((count) => count > 0))
    ctx.log.info(
      { legacyRows },
      "Bearers issued before the keyed row id are refused until their TTL ends",
    );
  await prepareLegacyScimRecovery(ctx);
  await resumePendingUpstreamLogouts(ctx);
  await resumePendingProvisionalRevocations(ctx);
  await resumePendingOrganizationRevocationAudits(ctx);
  await resumePendingOrganizationWithdrawalAudits(ctx);
}
