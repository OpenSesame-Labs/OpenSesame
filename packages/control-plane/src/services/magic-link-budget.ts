/** Atomic durable outbound-email limits for public and authenticated sign-in. */
import { createHmac } from "node:crypto";
import type { AppContext } from "../context.js";
import { updateSecurityMap } from "../repos/durable-map.js";
import { normalizeEmail } from "./email-normalization.js";

const WINDOW_MS = 10 * 60_000;
const GLOBAL_LIMIT = 200;
const RECIPIENT_LIMIT = 5;
const SOURCE_LIMIT = 20;
const BACKEND_APPLICATION_LIMIT = 100;
const LEDGER_KEY = "deployment";

export type MagicLinkBudgetLedger = {
  global: number[];
  recipients: Record<string, number[]>;
  sources: Record<string, number[]>;
  backendApplications: Record<string, number[]>;
  backendRecipients: Record<string, number[]>;
  expiresAt: number;
};

function fingerprint(ctx: AppContext, label: string, value: string): string {
  return createHmac("sha256", ctx.config.claimPepper)
    .update(`magic-link-budget/${label}\0`)
    .update(value)
    .digest("hex");
}

function live(values: number[] | undefined, now: number): number[] {
  return (values ?? []).filter((at) => at > now - WINDOW_MS);
}

function cleanGroups(
  groups: Record<string, number[]>,
  now: number,
): Record<string, number[]> {
  return Object.fromEntries(
    Object.entries(groups)
      .map(([key, values]) => [key, live(values, now)] as const)
      .filter(([, values]) => values.length > 0),
  );
}

function currentLedger(
  current: MagicLinkBudgetLedger | undefined,
  now: number,
): MagicLinkBudgetLedger {
  return {
    global: live(current?.global, now),
    recipients: cleanGroups(current?.recipients ?? {}, now),
    sources: cleanGroups(current?.sources ?? {}, now),
    backendApplications: cleanGroups(current?.backendApplications ?? {}, now),
    backendRecipients: cleanGroups(current?.backendRecipients ?? {}, now),
    expiresAt: now + WINDOW_MS,
  };
}

export async function chargeMagicLinkBudget(
  ctx: AppContext,
  email: string,
  source?: string,
): Promise<"ok" | "global" | "recipient" | "source"> {
  const now = ctx.clock().getTime();
  const recipient = fingerprint(ctx, "recipient", normalizeEmail(email));
  const sourceKey = fingerprint(ctx, "source", source ?? "unknown");
  let result: "ok" | "global" | "recipient" | "source" = "global";
  await updateSecurityMap(
    ctx.stores.magicLinkBudgets,
    LEDGER_KEY,
    (current) => {
      const ledger = currentLedger(current, now);
      const recipientWindow = ledger.recipients[recipient] ?? [];
      const sourceWindow = ledger.sources[sourceKey] ?? [];
      if (recipientWindow.length >= RECIPIENT_LIMIT) result = "recipient";
      else if (sourceWindow.length >= SOURCE_LIMIT) result = "source";
      else if (ledger.global.length >= GLOBAL_LIMIT) result = "global";
      else {
        result = "ok";
        recipientWindow.push(now);
        sourceWindow.push(now);
        ledger.global.push(now);
        ledger.recipients[recipient] = recipientWindow;
        ledger.sources[sourceKey] = sourceWindow;
      }
      return ledger;
    },
  );
  return result;
}

export async function chargeAuthenticationMagicLinkBudget(
  ctx: AppContext,
  applicationId: string,
  email: string,
): Promise<boolean> {
  const now = ctx.clock().getTime();
  const application = fingerprint(ctx, "backend-application", applicationId);
  const recipient = fingerprint(
    ctx,
    `backend-recipient/${applicationId}`,
    normalizeEmail(email),
  );
  let allowed = false;
  await updateSecurityMap(
    ctx.stores.magicLinkBudgets,
    LEDGER_KEY,
    (current) => {
      const ledger = currentLedger(current, now);
      const applicationWindow = ledger.backendApplications[application] ?? [];
      const recipientWindow = ledger.backendRecipients[recipient] ?? [];
      if (
        applicationWindow.length < BACKEND_APPLICATION_LIMIT &&
        recipientWindow.length < RECIPIENT_LIMIT
      ) {
        allowed = true;
        applicationWindow.push(now);
        recipientWindow.push(now);
        ledger.backendApplications[application] = applicationWindow;
        ledger.backendRecipients[recipient] = recipientWindow;
      }
      return ledger;
    },
  );
  return allowed;
}

export function resetMagicLinkBudgetForTest(ctx: AppContext): void {
  const store = ctx.stores.magicLinkBudgets;
  if (!(store instanceof Map))
    throw new Error("A memory test store is required.");
  store.clear();
}
