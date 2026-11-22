import { expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import { deprovision, deprovisionJournal } from "../routes/scim-effects.js";
import { deleteScimUser } from "../routes/scim-user-mutations.js";

const SCIM_DEPROVISION_PRINCIPALS_ATTRIBUTE =
  "urn:opensesame:params:scim:2.0:deprovision-principals";

// A legacy marker becomes an incarnation journal with one target per
// principal. Each target is completed on its own, so an interrupted run keeps
// exactly the unfinished targets pending and a retry finishes only those.
it("preserves unprocessed legacy retry targets through a failure and completes them on retry", async () => {
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
  let calls = 0;
  const revoked: string[] = [];
  const host = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_, init) => {
      if (calls++ === 64) return new Response("down", { status: 503 });
      revoked.push(JSON.parse(String(init?.body)).principal_id);
      return new Response(null, { status: 204 });
    });
  try {
    await expect(
      deleteScimUser(ctx, organization, user.id, "test"),
    ).rejects.toThrow("Host session revocation is unavailable");
    const pending = await ctx.stores.scim.users.getById(
      organization.id,
      user.id,
    );
    if (!pending) throw new Error("User disappeared");
    expect(pending.raw[SCIM_DEPROVISION_PRINCIPALS_ATTRIBUTE]).toBeUndefined();
    const journal = deprovisionJournal(pending);
    expect(journal?.targets.map((target) => target.principalId)).toEqual(
      targets,
    );
    expect(
      journal?.targets
        .filter((target) => !target.completed)
        .map((target) => target.principalId),
    ).toEqual(targets.slice(64));

    await deprovision(ctx, organization, pending, "retry");
    const finished = await ctx.stores.scim.users.getById(
      organization.id,
      user.id,
    );
    if (!finished) throw new Error("User disappeared");
    expect(
      deprovisionJournal(finished)?.targets.every((target) => target.completed),
    ).toBe(true);
    // Each principal reached Host exactly once: completed work is not redone.
    expect(revoked).toEqual(targets);
  } finally {
    host.mockRestore();
  }
});
