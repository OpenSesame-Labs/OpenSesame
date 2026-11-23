import type { AppContext } from "../context.js";
import { resumePendingUpstreamLogouts } from "../interactions/upstream-logout.js";
import { resumePendingOrganizationRevocationAudits } from "../repos/organization-revocation-audit.js";
import { resumePendingOrganizationWithdrawalAudits } from "../repos/organization-withdrawal-audit.js";
import { resumePendingProvisionalRevocations } from "../repos/provisional-revocation.js";
import { resumePendingOrganizationWithdrawals } from "./organization-withdrawal.js";
import { resumePendingScimDeprovision } from "./scim-deprovision-recovery.js";

/** A stoppable background recovery loop; pending memberships remain fenced. */
export function startOrganizationWithdrawalRecovery(ctx: AppContext) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let retryDelay = 1_000;

  async function sweep(): Promise<void> {
    let retry = false;
    for (const resume of [
      resumePendingUpstreamLogouts,
      resumePendingProvisionalRevocations,
      resumePendingOrganizationRevocationAudits,
      resumePendingOrganizationWithdrawalAudits,
    ]) {
      if (stopped) return;
      try {
        await resume(ctx);
      } catch {
        retry = true;
        ctx.log.warn("Security cleanup recovery failed; will retry");
      }
    }
    if (stopped) return;
    try {
      retry = (await resumePendingOrganizationWithdrawals(ctx)) || retry;
    } catch {
      retry = true;
      ctx.log.warn("Organization withdrawal recovery failed; will retry");
    }
    if (stopped) return;
    try {
      retry = (await resumePendingScimDeprovision(ctx)) || retry;
    } catch {
      retry = true;
      ctx.log.warn("SCIM recovery scan failed; will retry");
    }
    if (stopped) return;
    const delay = retry ? retryDelay : 30_000;
    retryDelay = retry ? Math.min(retryDelay * 2, 30_000) : 1_000;
    timer = setTimeout(() => {
      timer = undefined;
      running = sweep();
      void running.catch(() => ctx.log.warn("Security recovery sweep failed"));
    }, delay);
    timer.unref();
  }

  const firstPass = ctx.securityRecoveryReady.then(async () => {
    if (stopped) return;
    running = sweep();
    await running;
  });
  void firstPass.catch(() => undefined);
  return {
    firstPass,
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}
