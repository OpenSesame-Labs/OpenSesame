import { expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import { deprovision } from "../routes/scim-effects.js";

const SCIM_DEPROVISION_PRINCIPALS_ATTRIBUTE =
  "urn:opensesame:params:scim:2.0:deprovision-principals";

it("preserves unprocessed legacy retry targets through a failure and clears completed batches", async () => {
  const { app, ctx } = createControlPlane();
  const owner = await (
    await app.request("/v1/principals/provisional", { method: "POST" })
  ).json();
  const [membership] = await ctx.stores.organizationMemberships.listByPrincipal(
    owner.principalId,
  );
  if (!membership) throw new Error("Fixture organization missing");
  const organization = await ctx.stores.organizations.get(
    membership.organizationId,
  );
  if (!organization) throw new Error("Fixture organization missing");
  const targets = Array.from(
    { length: 130 },
    (_, index) => `prn_legacy_${index}`,
  );
  const now = ctx.clock();
  const user = await ctx.stores.scim.users.create({
    id: "scim-user",
    organizationId: organization.id,
    userName: "legacy@example.test",
    active: false,
    raw: { [SCIM_DEPROVISION_PRINCIPALS_ATTRIBUTE]: targets },
    createdAt: now,
    updatedAt: now,
  });
  const append = ctx.repos.auditEvents.append.bind(ctx.repos.auditEvents);
  let writes = 0;
  const interrupted = vi
    .spyOn(ctx.repos.auditEvents, "append")
    .mockImplementation(async (...args) => {
      if (writes++ === 64) throw new Error("injected audit failure");
      return append(...args);
    });
  await expect(deprovision(ctx, organization, user, "test")).rejects.toThrow(
    "injected audit failure",
  );
  interrupted.mockRestore();
  const pending = await ctx.stores.scim.users.getById(organization.id, user.id);
  if (!pending) throw new Error("User disappeared");
  const marker = pending.raw[SCIM_DEPROVISION_PRINCIPALS_ATTRIBUTE];
  expect(marker).toEqual(targets.slice(64));
  await deprovision(ctx, organization, pending, "retry");
  expect(
    (await ctx.stores.scim.users.getById(organization.id, user.id))?.raw[
      SCIM_DEPROVISION_PRINCIPALS_ATTRIBUTE
    ],
  ).toBeUndefined();
});
