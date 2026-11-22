import type {
  OrganizationRole,
  OrganizationState,
} from "@opensesame/os-domain";
import { afterEach, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";

type AuthorityRequest = { role: OrganizationRole; principalId?: string };

afterEach(() => vi.restoreAllMocks());

it.each(["provisional", "suspended", "deleted"] as const)(
  "blocks member and SCIM authority while the organization is %s",
  async (state: OrganizationState) => {
    const { app, ctx } = createControlPlane();
    const createPrincipal = async () => {
      const response = await app.request("/v1/principals/provisional", {
        method: "POST",
      });
      expect(response.status).toBe(201);
      return response.json();
    };
    const owner = await createPrincipal();
    const member = await createPrincipal();
    const newcomer = await createPrincipal();
    const membership = (
      await ctx.stores.organizationMemberships.listByPrincipal(
        owner.principalId,
      )
    )[0];
    if (!membership) throw new Error("Fixture organization missing");
    const id = membership.organizationId;
    const original = await ctx.stores.organizations.get(id);
    if (!original) throw new Error("Fixture organization missing");
    const headers = {
      authorization: `Bearer ${owner.accessToken}`,
      "content-type": "application/json",
    };
    const request = (path: string, method: string, body?: AuthorityRequest) => {
      const options: RequestInit = { method, headers };
      if (body) options.body = JSON.stringify(body);
      return app.request(`/v1/organizations/${id}${path}`, options);
    };

    expect(
      (
        await request("/members", "POST", {
          principalId: member.principalId,
          role: "member",
        })
      ).status,
    ).toBe(201);
    expect(
      (await request("/scim/mappings/team", "PUT", { role: "member" })).status,
    ).toBe(200);
    const minted = await request("/scim/tokens", "POST");
    expect(minted.status).toBe(201);
    const token = await minted.json();
    const directory = () =>
      app.request(`/v1/organizations/${id}/scim/v2/Users`, {
        headers: { authorization: `Bearer ${token.token}` },
      });
    expect((await directory()).status).toBe(200);
    await ctx.stores.organizations.set(id, { ...original, state });
    expect((await directory()).status).toBe(401);

    for (const response of [
      await request("/members", "GET"),
      await request("/members", "POST", {
        principalId: newcomer.principalId,
        role: "owner",
      }),
      await request(`/members/${member.principalId}`, "PATCH", {
        role: "admin",
      }),
      await request(`/members/${member.principalId}`, "DELETE"),
      await request("/scim/mappings", "GET"),
      await request("/scim/mappings/team", "PUT", { role: "owner" }),
      await request("/scim/mappings/team", "DELETE"),
      await request("/scim/tokens", "GET"),
      await request("/scim/tokens", "POST"),
      await request(`/scim/tokens/${token.id}`, "DELETE"),
      await request(`/scim/tokens/${token.id}/record`, "DELETE"),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }
    expect(
      await ctx.stores.organizationMemberships.find(id, newcomer.principalId),
    ).toBeUndefined();
    expect(
      await ctx.stores.organizationMemberships.find(id, member.principalId),
    ).toMatchObject({ role: "member" });
    expect(await ctx.stores.scim.mappings.listByOrganization(id)).toMatchObject(
      [{ groupId: "team", role: "member" }],
    );
    const tokens = await ctx.stores.scim.tokens.list(id);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ id: token.id });
    expect(tokens[0]?.revokedAt).toBeUndefined();

    // Deleted organizations remain deleted. Reactivating a suspended or
    // provisional organization preserves memberships and mappings.
    if (state === "deleted") return;
    await ctx.stores.organizations.set(id, original);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    expect((await directory()).status).toBe(200);
    expect((await request("/members", "GET")).status).toBe(200);
    expect((await request("/scim/mappings", "GET")).status).toBe(200);
    expect((await request("/scim/tokens", "GET")).status).toBe(200);
    expect((await request(`/scim/tokens/${token.id}`, "DELETE")).status).toBe(
      204,
    );
    expect((await directory()).status).toBe(401);
    expect(
      (await request("/scim/mappings/team", "PUT", { role: "owner" })).status,
    ).toBe(200);
    expect(
      (
        await request(`/members/${member.principalId}`, "PATCH", {
          role: "admin",
        })
      ).status,
    ).toBe(200);
    expect(
      (await request(`/members/${member.principalId}`, "DELETE")).status,
    ).toBe(204);
    expect(
      (
        await request("/members", "POST", {
          principalId: newcomer.principalId,
          role: "member",
        })
      ).status,
    ).toBe(201);
  },
);
