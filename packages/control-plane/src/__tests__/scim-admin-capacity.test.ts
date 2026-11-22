import { createMemoryScimStores } from "@opensesame/database";
import { expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";

async function fixture() {
  const plane = createControlPlane({
    scimStores: createMemoryScimStores(undefined, undefined, {
      tokensPerOrganization: 2,
      tokensPerDeployment: 4,
      mappingsPerOrganization: 2,
      mappingsPerDeployment: 4,
    }),
  });
  const owner = await (
    await plane.app.request("/v1/principals/provisional", { method: "POST" })
  ).json();
  const [membership] =
    await plane.ctx.stores.organizationMemberships.listByPrincipal(
      owner.principalId,
    );
  if (!membership) throw new Error("Fixture organization missing");
  const id = membership.organizationId;
  const headers = {
    authorization: `Bearer ${owner.accessToken}`,
    "content-type": "application/json",
  };
  const request = (
    path: string,
    method: string,
    body?: { role: "owner" | "admin" | "member" },
  ) => {
    const init: RequestInit = { method, headers };
    if (body) init.body = JSON.stringify(body);
    return plane.app.request(`/v1/organizations/${id}/scim${path}`, init);
  };
  return { ...plane, id, request };
}

it("bounds token records but still permits revocation, rotation and purging revoked history", async () => {
  const f = await fixture();
  const oneResponse = await f.request("/tokens", "POST");
  const twoResponse = await f.request("/tokens", "POST");
  expect(oneResponse.status).toBe(201);
  expect(twoResponse.status).toBe(201);
  const one = await oneResponse.json();
  const two = await twoResponse.json();
  expect((await f.request("/tokens", "POST")).status).toBe(409);
  expect((await f.request(`/tokens/${one.id}/record`, "DELETE")).status).toBe(
    409,
  );
  expect((await f.request(`/tokens/${one.id}`, "DELETE")).status).toBe(204);
  const rotated = await f.request("/tokens", "POST");
  expect(rotated.status).toBe(201);
  const page = await (
    await f.request("/tokens?startIndex=2&count=1", "GET")
  ).json();
  expect(page.totalResults).toBe(2);
  expect(page.itemsPerPage).toBe(1);
  expect(page.tokens).toHaveLength(1);
  const listing = await (await f.request("/tokens", "GET")).json();
  expect(listing.tokens.map((row: { id: string }) => row.id)).toContain(two.id);
  expect(JSON.stringify(listing)).not.toContain(two.token);
  expect((await f.request(`/tokens/${two.id}`, "DELETE")).status).toBe(204);
  expect((await f.request(`/tokens/${two.id}/record`, "DELETE")).status).toBe(
    204,
  );
  expect((await f.request(`/tokens/${two.id}/record`, "DELETE")).status).toBe(
    409,
  );
});

it("requires explicit pages for legacy over-cap listings instead of hiding records", async () => {
  const f = await fixture();
  vi.spyOn(f.ctx.stores.scim.tokens, "count").mockResolvedValue(101);
  const defaultPage = await f.request("/tokens", "GET");
  expect(defaultPage.status).toBe(409);
  expect(await defaultPage.json()).toMatchObject({
    error: "pagination_required",
    totalResults: 101,
  });
  const explicit = await f.request("/tokens?startIndex=101&count=1", "GET");
  expect(explicit.status).toBe(200);
  expect(await explicit.json()).toMatchObject({
    totalResults: 101,
    startIndex: 101,
    tokens: [],
  });
  expect((await f.request("/tokens?count=-1", "GET")).status).toBe(400);
  vi.spyOn(f.ctx.stores.scim.mappings, "count").mockResolvedValue(101);
  expect((await f.request("/mappings", "GET")).status).toBe(409);
  const mappings = await f.request("/mappings?startIndex=101&count=1", "GET");
  expect(mappings.status).toBe(200);
  expect(await mappings.json()).toMatchObject({
    totalResults: 101,
    startIndex: 101,
    mappings: [],
  });
});

it("bounds mappings, protects non-neutral roles and allows capacity to be reclaimed", async () => {
  const f = await fixture();
  expect(
    (await f.request("/mappings/one", "PUT", { role: "owner" })).status,
  ).toBe(200);
  expect(
    (await f.request("/mappings/two", "PUT", { role: "member" })).status,
  ).toBe(200);
  expect(
    (await f.request("/mappings/three", "PUT", { role: "admin" })).status,
  ).toBe(409);
  expect((await f.request("/mappings/one", "DELETE")).status).toBe(409);
  expect(
    (await f.request("/mappings/one", "PUT", { role: "member" })).status,
  ).toBe(200);
  expect((await f.request("/mappings/one", "DELETE")).status).toBe(204);
  expect(
    (await f.request("/mappings/three", "PUT", { role: "admin" })).status,
  ).toBe(200);
  const page = await (
    await f.request("/mappings?startIndex=2&count=1", "GET")
  ).json();
  expect(page.totalResults).toBe(2);
  expect(page.mappings).toHaveLength(1);
  const events = await f.ctx.repos.auditEvents.list({ limit: 100 });
  expect(
    events.some(
      (event) => event.eventType === "organization.scim_mapping_removed",
    ),
  ).toBe(true);
});
