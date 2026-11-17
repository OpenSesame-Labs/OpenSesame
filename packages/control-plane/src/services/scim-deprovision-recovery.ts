import type { AppContext } from "../context.js";
import { withScimOrganizationBoundary } from "../repos/scim-organization-boundary.js";
import { deprovision, deprovisionJournal } from "../routes/scim-effects.js";
import { fenceLegacyOrphan } from "../routes/scim-legacy-orphan.js";
import { prepareLegacyDeprovision } from "../routes/scim-legacy-recovery.js";
import {
  forgetScimDeprovision,
  queueScimDeprovision,
  queuedScimDeprovisions,
} from "./scim-deprovision-queue.js";

const PAGE_SIZE = 200;
const CORRELATION_ID = "scim-deprovision-recovery";

async function eachInactive(
  ctx: AppContext,
  visit: (organizationId: string, userId: string) => Promise<void>,
) {
  let cursor: string | undefined;
  while (true) {
    const page = await ctx.stores.scim.users.listInactiveForRecovery(
      cursor,
      PAGE_SIZE,
    );
    for (const row of page) await visit(row.organizationId, row.id);
    if (page.length < PAGE_SIZE) return;
    cursor = page[page.length - 1]?.id;
  }
}

/** Fence every legacy inactive user before this replica accepts traffic. */
export async function prepareLegacyScimRecovery(
  ctx: AppContext,
): Promise<void> {
  await eachInactive(ctx, async (organizationId, userId) => {
    const user = await withScimOrganizationBoundary(
      ctx,
      organizationId,
      async (tx) => {
        const current = await tx.stores.scim.users.getVersioned(
          organizationId,
          userId,
        );
        if (!current || current.user.active) return;
        const organization = await tx.stores.organizations.get(organizationId);
        if (!organization)
          throw new Error("SCIM organization no longer exists");
        return prepareLegacyDeprovision(
          tx,
          organization,
          current.user,
          current.revision,
          CORRELATION_ID,
        );
      },
    );
    if (!user) return;
    const journal = deprovisionJournal(user);
    if (journal?.targets.some((target) => !target.completed)) {
      queueScimDeprovision(ctx, {
        organizationId,
        userId,
        cycle: journal.cycle,
      });
    }
    for (const target of journal?.targets ?? []) {
      await fenceLegacyOrphan(ctx, organizationId, target, CORRELATION_ID);
    }
  });
}

/** Finish journals even when a directory never retries the original request. */
export async function resumePendingScimDeprovision(
  ctx: AppContext,
): Promise<boolean> {
  let retry = false;
  for (const work of queuedScimDeprovisions(ctx)) {
    const { organizationId, userId } = work;
    const user = await ctx.stores.scim.users.getById(organizationId, userId);
    if (!user || user.active) {
      forgetScimDeprovision(ctx, work);
      continue;
    }
    const journal = deprovisionJournal(user);
    if (!journal) {
      retry = true;
      continue;
    }
    if (
      journal.cycle !== work.cycle ||
      !journal.targets.some((target) => !target.completed)
    ) {
      forgetScimDeprovision(ctx, work);
      continue;
    }
    const organization = await ctx.stores.organizations.get(organizationId);
    if (!organization) throw new Error("SCIM organization no longer exists");
    try {
      await deprovision(ctx, organization, user, CORRELATION_ID);
    } catch {
      retry = true;
    }
  }
  if (retry) ctx.log.warn("SCIM deprovision recovery failed; will retry");
  return retry;
}
