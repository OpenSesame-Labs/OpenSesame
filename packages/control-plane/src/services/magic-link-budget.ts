/** Shared, durable outbound-email limits for both hosted and first-party sign-in. */
import { createHmac } from "node:crypto";
import type { AppContext } from "../context.js";
import { updateSecurityMap } from "../repos/durable-map.js";
import { normalizeEmail } from "./email-normalization.js";

const PREFIX = "magic-link:";
const WINDOW_MS = 10 * 60_000;
const GLOBAL_LIMIT = 200;
const RECIPIENT_LIMIT = 5;

function fingerprint(ctx: AppContext, label: string, value: string): string {
  return createHmac("sha256", ctx.config.claimPepper)
    .update(`magic-link-budget/${label}\0`)
    .update(value)
    .digest("hex");
}

async function chargeWindow(
  ctx: AppContext,
  key: string,
  limit: number,
  now: number,
): Promise<boolean> {
  let allowed = false;
  await updateSecurityMap(ctx.stores.mfaCodeSends, key, (current) => {
    const live = (current?.sentAt ?? []).filter((at) => at > now - WINDOW_MS);
    if (live.length < limit) {
      live.push(now);
      allowed = true;
    }
    return { sentAt: live, expiresAt: Math.max(now, ...live) + WINDOW_MS };
  });
  return allowed;
}

export async function chargeMagicLinkBudget(
  ctx: AppContext,
  email: string,
): Promise<"ok" | "global" | "recipient"> {
  const now = ctx.clock().getTime();
  const store = ctx.stores.mfaCodeSends;
  if (store instanceof Map) {
    for (const [key, value] of store) {
      if (key.startsWith(PREFIX) && value.expiresAt <= now) store.delete(key);
    }
  }
  if (!(await chargeWindow(ctx, `${PREFIX}global`, GLOBAL_LIMIT, now)))
    return "global";
  const recipient = fingerprint(ctx, "recipient", normalizeEmail(email));
  if (
    !(await chargeWindow(
      ctx,
      `${PREFIX}recipient:${recipient}`,
      RECIPIENT_LIMIT,
      now,
    ))
  )
    return "recipient";
  return "ok";
}

/** Test-only reset for an isolated memory store. */
export function resetMagicLinkBudgetForTest(ctx: AppContext): void {
  const store = ctx.stores.mfaCodeSends;
  if (!(store instanceof Map))
    throw new Error("A memory test store is required.");
  for (const key of store.keys()) if (key.startsWith(PREFIX)) store.delete(key);
}
