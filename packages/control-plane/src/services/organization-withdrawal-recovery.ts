import type { AppContext } from "../context.js";
import { resumePendingOrganizationWithdrawalAudits } from "../repos/organization-withdrawal-audit.js";
import { finishOrganizationWithdrawal } from "./organization-withdrawal.js";

/** Retry persisted transitions after restart; unavailable Host leaves them fenced. */
export async function resumePendingOrganizationWithdrawals(
  ctx: AppContext,
): Promise<boolean> {
  await resumePendingOrganizationWithdrawalAudits(ctx);
  const pending =
    await ctx.stores.organizationMemberships.listPendingWithdrawals();
  let next = 0;
  let retry = false;
  const worker = async () => {
    while (next < pending.length) {
      const item = pending[next++];
      if (!item) return;
      try {
        if (
          (await finishOrganizationWithdrawal(ctx, item)).status === "pending"
        )
          retry = true;
      } catch {
        retry = true;
        ctx.log.warn("Organization withdrawal recovery failed; will retry");
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(4, pending.length) }, worker),
  );
  return retry;
}
