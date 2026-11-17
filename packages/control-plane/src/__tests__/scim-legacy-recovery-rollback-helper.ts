import type { Organization } from "@opensesame/os-domain";
import { expect } from "vitest";
import { createControlPlane } from "../create-app.js";
import { withScimOrganizationBoundary } from "../repos/scim-organization-boundary.js";
import {
  SCIM_DEPROVISION_JOURNAL_ATTRIBUTE,
  deprovisionJournal,
} from "../routes/scim-effects.js";
import { prepareLegacyDeprovision } from "../routes/scim-legacy-recovery.js";

export async function expectRecoveryRollback(
  first: ReturnType<typeof createControlPlane>,
  organization: Organization,
  principalId: string,
) {
  await expect(
    withScimOrganizationBoundary(first.ctx, organization.id, async (tx) => {
      const current = await tx.stores.scim.users.getVersioned(
        organization.id,
        "legacy-before",
      );
      if (!current) throw new Error("Expected a legacy user");
      await prepareLegacyDeprovision(
        tx,
        organization,
        current.user,
        current.revision,
        "failed-recovery",
      );
      throw new Error("injected transaction failure");
    }),
  ).rejects.toThrow("injected transaction failure");
  expect(
    (
      await first.ctx.stores.organizationMemberships.findVersioned(
        organization.id,
        principalId,
      )
    )?.withdrawal,
  ).toBeUndefined();
  const rolledBack = await first.ctx.stores.scim.users.getById(
    organization.id,
    "legacy-before",
  );
  expect(rolledBack && deprovisionJournal(rolledBack)).toBeUndefined();
}

export async function expectInvalidJournalFailsClosed(
  first: ReturnType<typeof createControlPlane>,
  options: Parameters<typeof createControlPlane>[0],
  organization: Organization,
  now: Date,
) {
  await first.ctx.stores.scim.users.create({
    id: "bad-journal",
    organizationId: organization.id,
    userName: "bad-journal",
    active: false,
    createdAt: now,
    updatedAt: now,
    raw: { [SCIM_DEPROVISION_JOURNAL_ATTRIBUTE]: { cycle: "", targets: [] } },
  });
  const invalid = createControlPlane(options);
  await expect(invalid.ctx.securityRecoveryReady).rejects.toThrow(
    "Invalid SCIM deprovision journal",
  );
  expect((await invalid.app.request("/v1/health/ready")).status).toBe(503);
  await invalid.withdrawalRecovery.stop();
}
