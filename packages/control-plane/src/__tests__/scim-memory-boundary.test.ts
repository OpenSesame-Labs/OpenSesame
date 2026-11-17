import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { withScimOrganizationBoundary } from "../repos/scim-organization-boundary.js";

const now = new Date("2026-11-17T00:00:00Z");
const organizationId = "org-memory-boundary";
const membership = {
  organizationId,
  principalId: "principal-memory-boundary",
  role: "member" as const,
  createdAt: now,
  updatedAt: now,
};
const user = {
  id: "scim-memory-boundary",
  organizationId,
  userName: "member@example.test",
  active: true,
  raw: {},
  createdAt: now,
  updatedAt: now,
};
const group = {
  id: "group-memory-boundary",
  organizationId,
  displayName: "Members",
  memberIds: [user.id],
  createdAt: now,
  updatedAt: now,
};

function plane() {
  return createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://localhost",
      issuer: "http://localhost",
    },
  });
}

describe("in-memory SCIM organization boundary", () => {
  it("discards staged membership, user, group and mapping writes when a callback fails", async () => {
    const { ctx } = plane();
    await ctx.securityRecoveryReady;
    await expect(
      withScimOrganizationBoundary(ctx, organizationId, async (staged) => {
        await staged.stores.organizationMemberships.upsert(membership);
        await staged.stores.scim.users.create(user);
        await staged.stores.scim.groups.upsert(group);
        await staged.stores.scim.mappings.put(
          organizationId,
          group.id,
          "member",
        );
        throw new Error("interrupted directory update");
      }),
    ).rejects.toThrow("interrupted directory update");
    expect(
      await ctx.stores.organizationMemberships.find(
        organizationId,
        membership.principalId,
      ),
    ).toBeUndefined();
    expect(
      await ctx.stores.scim.users.getById(organizationId, user.id),
    ).toBeNull();
    expect(
      await ctx.stores.scim.groups.getById(organizationId, group.id),
    ).toBeNull();
    expect(
      await ctx.stores.scim.mappings.get(organizationId, group.id),
    ).toBeUndefined();
  });

  it("rejects a stale staged transaction without overwriting a concurrent membership change", async () => {
    const { ctx } = plane();
    await ctx.securityRecoveryReady;
    await ctx.stores.organizationMemberships.upsert(membership);
    let release = () => {};
    let announce = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const transaction = withScimOrganizationBoundary(
      ctx,
      organizationId,
      async (staged) => {
        await staged.stores.scim.users.create(user);
        await staged.stores.organizationMemberships.upsert({
          ...membership,
          role: "admin",
        });
        announce();
        await gate;
      },
    );
    await paused;
    await ctx.stores.organizationMemberships.upsert({
      ...membership,
      role: "owner",
    });
    release();
    await expect(transaction).rejects.toThrow(/changed concurrently/i);
    expect(
      (
        await ctx.stores.organizationMemberships.find(
          organizationId,
          membership.principalId,
        )
      )?.role,
    ).toBe("owner");
    expect(
      await ctx.stores.scim.users.getById(organizationId, user.id),
    ).toBeNull();
  });

  it("serializes shared-store replicas so the second transaction reads the first result", async () => {
    const { ctx } = plane();
    await ctx.securityRecoveryReady;
    const replica = { ...ctx, stores: { ...ctx.stores } };
    let release = () => {};
    let announce = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const first = withScimOrganizationBoundary(
      ctx,
      organizationId,
      async (staged) => {
        await staged.stores.scim.users.create(user);
        announce();
        await gate;
      },
    );
    await paused;
    const second = withScimOrganizationBoundary(
      replica,
      organizationId,
      async (staged) => {
        const existing = await staged.stores.scim.users.getById(
          organizationId,
          user.id,
        );
        if (!existing) throw new Error("First transaction was not committed");
        await staged.stores.scim.users.update({ ...existing, active: false });
      },
    );
    release();
    await Promise.all([first, second]);
    expect(
      (await ctx.stores.scim.users.getById(organizationId, user.id))?.active,
    ).toBe(false);
  });
});
