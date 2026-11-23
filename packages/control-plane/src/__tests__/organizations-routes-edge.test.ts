import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";

import {
  auth,
  createOrg,
  provisional,
  testConfig,
  verified,
} from "./organizations-edge.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("organizations routes edge cases", () => {
  it("gates creation on assurance, validation, and slug uniqueness", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const anon = await provisional(app);

    const lowAssurance = await createOrg(app, anon.accessToken, "anon-org");
    expect(lowAssurance.status).toBe(403);
    expect(overlapCast(await lowAssurance.json()).error).toBe(
      "assurance_too_low",
    );

    const owner = await verified(app, "org-create-owner");
    const invalid = await app.request("/v1/organizations", {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ slug: "BAD SLUG", displayName: "Nope" }),
    });
    expect(invalid.status).toBe(400);

    expect((await createOrg(app, owner.accessToken, "acme")).status).toBe(201);
    const dupe = await createOrg(app, owner.accessToken, "acme");
    expect(dupe.status).toBe(409);
    expect(overlapCast(await dupe.json()).error).toBe("slug_taken");
  });

  it("reads hide deleted and foreign organizations", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "org-read-owner");
    const outsider = await verified(app, "org-read-outsider");

    const created = await createOrg(app, owner.accessToken, "readable");
    const org = overlapCast(await created.json());

    expect(
      (
        await app.request(`/v1/organizations/${org.id}`, {
          headers: auth(owner.accessToken),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(`/v1/organizations/${org.id}`, {
          headers: auth(outsider.accessToken),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request("/v1/organizations/org:missing", {
          headers: auth(owner.accessToken),
        })
      ).status,
    ).toBe(404);

    // A deleted org disappears from reads and lists.
    const stored = await ctx.stores.organizations.get(org.id);
    if (!stored) throw new Error("org missing");
    await ctx.stores.organizations.set(org.id, {
      ...stored,
      state: "deleted",
    });
    expect(
      (
        await app.request(`/v1/organizations/${org.id}`, {
          headers: auth(owner.accessToken),
        })
      ).status,
    ).toBe(404);
    const list = await app.request("/v1/organizations", {
      headers: auth(owner.accessToken),
    });
    const ids = overlapCast(await list.json()).organizations.map((o) => o.id);
    expect(ids).not.toContain(org.id);
  });

  it.each(["suspended", "deleted"] as const)(
    "retires member-management authority when the organization is %s",
    async (state) => {
      const { app, ctx } = createControlPlane({ config: testConfig() });
      const owner = await verified(app, `org-inactive-owner-${state}`);
      const target = await provisional(app);
      const org = overlapCast(
        await (
          await createOrg(app, owner.accessToken, `inactive-members-${state}`)
        ).json(),
      );
      const stored = await ctx.stores.organizations.get(String(org.id));
      if (!stored) throw new Error("organization missing");
      await ctx.stores.organizations.set(stored.id, {
        ...stored,
        state,
        updatedAt: new Date(),
      });

      expect(
        (
          await app.request(`/v1/organizations/${org.id}/members`, {
            headers: auth(owner.accessToken),
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await app.request(`/v1/organizations/${org.id}/members`, {
            method: "POST",
            headers: {
              ...auth(owner.accessToken),
              "content-type": "application/json",
            },
            body: JSON.stringify({
              principalId: target.principalId,
              role: "member",
            }),
          })
        ).status,
      ).toBe(404);
    },
  );

  it("lists members only for owners", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "org-members-owner");
    const member = await provisional(app);
    const outsider = await provisional(app);

    const org = overlapCast(
      await (await createOrg(app, owner.accessToken, "members-org")).json(),
    );

    expect(
      (
        await app.request(`/v1/organizations/${org.id}/members`, {
          headers: auth(outsider.accessToken),
        })
      ).status,
    ).toBe(404);

    const addMember = await app.request(`/v1/organizations/${org.id}/members`, {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ principalId: member.principalId, role: "member" }),
    });
    expect(addMember.status).toBe(201);

    const asMember = await app.request(`/v1/organizations/${org.id}/members`, {
      headers: auth(member.accessToken),
    });
    expect(asMember.status).toBe(403);
    expect(overlapCast(await asMember.json()).error).toBe("owner_required");

    const asOwner = await app.request(`/v1/organizations/${org.id}/members`, {
      headers: auth(owner.accessToken),
    });
    expect(asOwner.status).toBe(200);
    expect(overlapCast(await asOwner.json()).members).toHaveLength(2);
  });

  it("fences member addition by role and principal state", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    const owner = await verified(app, "org-add-owner");
    const member = await provisional(app);
    const third = await provisional(app);
    const outsider = await provisional(app);

    const org = overlapCast(
      await (await createOrg(app, owner.accessToken, "add-org")).json(),
    );
    const add = (token: string, body: BoundaryValue) =>
      app.request(`/v1/organizations/${org.id}/members`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    expect(
      (
        await add(outsider.accessToken, {
          principalId: third.principalId,
          role: "member",
        })
      ).status,
    ).toBe(404);
    expect(
      (await add(owner.accessToken, { principalId: third.principalId })).status,
    ).toBe(400);
    expect(
      (
        await add(owner.accessToken, {
          principalId: "prn_missing",
          role: "member",
        })
      ).status,
    ).toBe(404);

    const suspendedRecord = await ctx.repos.principals.getById(
      third.principalId,
    );
    if (!suspendedRecord) throw new Error("principal missing");
    await ctx.repos.principals.update(
      third.principalId,
      { state: "suspended" },
      suspendedRecord.version,
    );
    const inactive = await add(owner.accessToken, {
      principalId: third.principalId,
      role: "member",
    });
    expect(inactive.status).toBe(409);
    expect(overlapCast(await inactive.json()).error).toBe("principal_inactive");

    expect(
      (
        await add(owner.accessToken, {
          principalId: member.principalId,
          role: "member",
        })
      ).status,
    ).toBe(201);
    const dupe = await add(owner.accessToken, {
      principalId: member.principalId,
      role: "member",
    });
    expect(dupe.status).toBe(409);
    expect(overlapCast(await dupe.json()).error).toBe("membership_exists");

    // A plain member cannot add anyone.
    expect(
      (
        await add(member.accessToken, {
          principalId: outsider.principalId,
          role: "member",
        })
      ).status,
    ).toBe(403);
  });
});
