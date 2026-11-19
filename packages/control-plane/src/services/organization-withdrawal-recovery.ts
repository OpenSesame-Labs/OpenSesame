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

const WITHDRAWAL_RETRY_MS = 1_000;
const WITHDRAWAL_RETRY_MAX_MS = 60_000;
type ScheduleRetry = (run: () => void, delayMs: number) => void;

const scheduleRetry: ScheduleRetry = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  timer.unref();
};

export function scheduleOrganizationWithdrawalRecovery(
  ctx: AppContext,
  ready: Promise<void>,
  warn: () => void,
  schedule: ScheduleRetry = scheduleRetry,
): AppContext {
  let delayMs = WITHDRAWAL_RETRY_MS;
  const retry = () => {
    schedule(recover, delayMs);
    delayMs = Math.min(delayMs * 2, WITHDRAWAL_RETRY_MAX_MS);
  };
  const recover = () => {
    void ready
      .then(() => resumePendingOrganizationWithdrawals(ctx))
      .then((pending) => {
        if (pending) delayMs = WITHDRAWAL_RETRY_MS;
        retry();
      })
      .catch(() => {
        warn();
        retry();
      });
  };
  recover();
  return ctx;
}
