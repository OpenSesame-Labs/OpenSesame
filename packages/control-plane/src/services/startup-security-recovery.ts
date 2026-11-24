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
  const legacyRows = await rekeyLegacySecurityRows(ctx.stores);
  if (Object.values(legacyRows).some((count) => count > 0))
    ctx.log.info({ legacyRows }, "Legacy security row ids remain");
  await prepareLegacyScimRecovery(ctx);
  await resumePendingUpstreamLogouts(ctx);
  await resumePendingProvisionalRevocations(ctx);
  await resumePendingOrganizationRevocationAudits(ctx);
  await resumePendingOrganizationWithdrawalAudits(ctx);
}
