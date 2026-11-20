import type { AppContext } from "../context.js";
import { resumePendingOrganizationWithdrawalAudits } from "../repos/organization-withdrawal-audit.js";
import { deprovision } from "../routes/scim-effects.js";
import { finishOrganizationWithdrawal } from "./organization-withdrawal.js";

const RECOVERY_BATCH_SIZE = 100;
const deprovisionCursors = new WeakMap<object, string>();

/** Retry persisted transitions after restart; unavailable Host leaves them fenced. */
export async function resumePendingOrganizationWithdrawals(
  ctx: AppContext,
): Promise<boolean> {
  let retry = false;
  try {
    await resumePendingOrganizationWithdrawalAudits(ctx);
  } catch {
    retry = true;
    ctx.log.warn("Organization withdrawal audit recovery failed; will retry");
  }
  let deprovisions: Awaited<
    ReturnType<typeof ctx.stores.scim.users.listPendingDeprovisions>
  > = [];
  try {
    const cursor = deprovisionCursors.get(ctx.stores.scim.users);
    deprovisions = await ctx.stores.scim.users.listPendingDeprovisions(
      RECOVERY_BATCH_SIZE,
      cursor,
    );
    const last = deprovisions.at(-1);
    if (last && deprovisions.length === RECOVERY_BATCH_SIZE) {
      deprovisionCursors.set(ctx.stores.scim.users, last.id);
      retry = true;
    } else {
      deprovisionCursors.delete(ctx.stores.scim.users);
    }
  } catch {
    retry = true;
    ctx.log.warn("SCIM deprovision listing failed; will retry");
  }
  let deprovisionIndex = 0;
  const recoverDeprovision = async () => {
    while (deprovisionIndex < deprovisions.length) {
      const user = deprovisions[deprovisionIndex++];
      if (!user) return;
      try {
        await deprovision(
          ctx,
          { id: user.organizationId },
          user,
          `scim-recovery:${user.id}`,
        );
      } catch {
        retry = true;
        ctx.log.warn("SCIM deprovision recovery failed; will retry");
      }
    }
  };
  let pending: Awaited<
    ReturnType<typeof ctx.stores.organizationMemberships.listPendingWithdrawals>
  > = [];
  try {
    pending = await ctx.stores.organizationMemberships.listPendingWithdrawals();
  } catch {
    retry = true;
    ctx.log.warn("Organization withdrawal listing failed; will retry");
  }
  let next = 0;
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
  await Promise.all([
    ...Array.from(
      { length: Math.min(4, deprovisions.length) },
      recoverDeprovision,
    ),
    ...Array.from({ length: Math.min(4, pending.length) }, worker),
  ]);
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
  initialSweep = true,
): AppContext {
  let retryDelayMs = WITHDRAWAL_RETRY_MS;
  const retry = () => {
    schedule(recover, retryDelayMs);
    retryDelayMs = Math.min(retryDelayMs * 2, WITHDRAWAL_RETRY_MAX_MS);
  };
  const recover = () => {
    void ready
      .then(() => resumePendingOrganizationWithdrawals(ctx))
      .then((pending) => {
        if (pending) retry();
        else {
          retryDelayMs = WITHDRAWAL_RETRY_MS;
          schedule(recover, WITHDRAWAL_RETRY_MAX_MS);
        }
      })
      .catch(() => {
        warn();
        retry();
      });
  };
  if (initialSweep) recover();
  else
    void ready
      .then(() => schedule(recover, WITHDRAWAL_RETRY_MAX_MS))
      .catch(warn);
  return ctx;
}
