import {
  SCIM_PAGE_MAX,
  SCIM_USER_RAW_MAX_BYTES,
  createMemoryScimStores,
} from "@opensesame/database";
import type { JsonValue } from "@opensesame/os-domain";
import { expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { consumeScimMutation } from "../routes/scim-rate-limit.js";

type GroupPatch = {
  displayName?: string;
  Operations?: Array<{
    op: string;
    path: string;
    value: Array<{ value: string }>;
  }>;
};

async function fixture(userLimit = 200) {
  const plane = createControlPlane({
    scimStores: createMemoryScimStores(
      { perOrganization: userLimit, perDeployment: 300 },
      { perOrganization: 2, perDeployment: 3 },
    ),
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
  const minted = await plane.app.request(
    `/v1/organizations/${id}/scim/tokens`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${owner.accessToken}` },
    },
  );
  expect(minted.status).toBe(201);
  const { token } = await minted.json();
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/scim+json",
  };
  const users = `/v1/organizations/${id}/scim/v2/Users`;
  return { ...plane, id, headers, users };
}

it("caps pages at the database boundary and reports true totals for filtered and unfiltered requests", async () => {
  const f = await fixture();
  const createdAt = new Date("2026-01-01T00:00:00Z");
  for (let i = 0; i < SCIM_PAGE_MAX + 5; i += 1) {
    const id = `user-${String(i).padStart(3, "0")}`;
    await f.ctx.stores.scim.users.create({
      id,
      organizationId: f.id,
      userName: `${id}@example.test`,
      active: true,
      raw: {},
      createdAt,
      updatedAt: createdAt,
    });
  }
  const get = async (query: string) => {
    const response = await f.app.request(`${f.users}${query}`, {
      headers: f.headers,
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  const first = await get("");
  expect(first.totalResults).toBe(SCIM_PAGE_MAX + 5);
  expect(first.itemsPerPage).toBe(SCIM_PAGE_MAX);
  expect(first.startIndex).toBe(1);
  expect(first.Resources[0].id).toBe("user-000");
  const second = await get(`?startIndex=${SCIM_PAGE_MAX + 1}&count=9999`);
  expect(second.totalResults).toBe(SCIM_PAGE_MAX + 5);
  expect(second.itemsPerPage).toBe(5);
  expect(second.Resources[0].id).toBe("user-100");
  expect((await get("?count=0")).Resources).toEqual([]);
  expect(
    (await get("?startIndex=9999999999999999999999&count=2")).Resources,
  ).toEqual([]);
  const filter = `filter=${encodeURIComponent('userName eq "user-000@example.test"')}`;
  const filtered = await get(`?${filter}&startIndex=2`);
  expect(filtered.totalResults).toBe(1);
  expect(filtered.Resources).toEqual([]);
  for (const query of ["?count=1e3", "?startIndex=no", "?count=1&count=2"]) {
    const response = await f.app.request(`${f.users}${query}`, {
      headers: f.headers,
    });
    expect(response.status).toBe(400);
    expect((await response.json()).scimType).toBe("invalidValue");
  }
});

it("rejects oversized user attributes without creating a row", async () => {
  const f = await fixture();
  const response = await f.app.request(f.users, {
    method: "POST",
    headers: f.headers,
    body: JSON.stringify({
      userName: "large@example.test",
      extension: "x".repeat(SCIM_USER_RAW_MAX_BYTES),
    }),
  });
  expect(response.status).toBe(413);
  expect(response.headers.get("content-type")).toContain(
    "application/scim+json",
  );
  expect(
    await f.ctx.stores.scim.users.findByUserName(f.id, "large@example.test"),
  ).toBeNull();

  let nested: JsonValue = "leaf";
  for (let i = 0; i < 40; i += 1) nested = { nested };
  const deep = await f.app.request(f.users, {
    method: "POST",
    headers: f.headers,
    body: JSON.stringify({ userName: "deep@example.test", nested }),
  });
  expect(deep.status).toBe(413);
  expect(
    await f.ctx.stores.scim.users.findByUserName(f.id, "deep@example.test"),
  ).toBeNull();
});

it("rejects concurrent creates above the tenant quota with a SCIM error", async () => {
  const f = await fixture(2);
  const responses = await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      f.app.request(f.users, {
        method: "POST",
        headers: f.headers,
        body: JSON.stringify({ userName: `user-${i}@example.test` }),
      }),
    ),
  );
  expect(responses.map((response) => response.status).sort()).toEqual([
    201, 201, 409, 409,
  ]);
  const rejected = responses.find((response) => response.status === 409);
  if (!rejected) throw new Error("Expected quota refusal");
  expect((await rejected.json()).schemas).toEqual([
    "urn:ietf:params:scim:api:messages:2.0:Error",
  ]);
  expect(
    (
      await f.ctx.stores.scim.users.listByOrganization(f.id, {
        startIndex: 1,
        count: 100,
      })
    ).totalResults,
  ).toBe(2);
});

it("enforces atomic tenant and deployment mutation windows", async () => {
  let now = Date.now();
  const { ctx } = createControlPlane({ clock: () => new Date(now) });
  const limits = { tenant: 2, deployment: 3, windowMs: 60_000 };
  const admitted = await Promise.all(
    Array.from({ length: 4 }, () => consumeScimMutation(ctx, "one", limits)),
  );
  expect(admitted.filter(Boolean)).toHaveLength(2);
  expect(await consumeScimMutation(ctx, "two", limits)).toBe(true);
  expect(await consumeScimMutation(ctx, "two", limits)).toBe(false);
  now += 60_001;
  expect(await consumeScimMutation(ctx, "one", limits)).toBe(true);
  expect(await consumeScimMutation(ctx, "three", limits, 3)).toBe(false);
  expect(await consumeScimMutation(ctx, "three", limits)).toBe(true);
});

it("returns a retryable error for mutations when the tenant budget is exhausted", async () => {
  const f = await fixture();
  const rates = f.ctx.stores.scimMutationRates;
  if (!(rates instanceof Map)) throw new Error("Expected local security map");
  rates.set(`tenant:${f.id}`, {
    count: 600,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const response = await f.app.request(f.users, {
    method: "POST",
    headers: f.headers,
    body: JSON.stringify({ userName: "blocked@example.test" }),
  });
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("60");
  expect((await f.app.request(f.users, { headers: f.headers })).status).toBe(
    200,
  );
  expect(
    await f.ctx.stores.scim.users.findByUserName(f.id, "blocked@example.test"),
  ).toBeNull();
});

it("bounds subject history without preventing a standalone deactivation", async () => {
  const f = await fixture();
  const created = await f.app.request(f.users, {
    method: "POST",
    headers: f.headers,
    body: JSON.stringify({ userName: "subject-0@example.test" }),
  });
  expect(created.status).toBe(201);
  const row = await created.json();
  const patch = (path: string, value: string | boolean) =>
    f.app.request(`${f.users}/${row.id}`, {
      method: "PATCH",
      headers: f.headers,
      body: JSON.stringify({ Operations: [{ op: "replace", path, value }] }),
    });
  for (let i = 1; i < 64; i += 1)
    expect((await patch("userName", `subject-${i}@example.test`)).status).toBe(
      200,
    );
  expect((await patch("userName", "over-limit@example.test")).status).toBe(409);
  expect((await patch("active", false)).status).toBe(200);
  expect((await f.ctx.stores.scim.users.getById(f.id, row.id))?.active).toBe(
    false,
  );
});

it("refuses excessive group mutations and keeps an existing group updateable at capacity", async () => {
  const f = await fixture();
  const group = (id: string, body: GroupPatch) =>
    f.app.request(`/v1/organizations/${f.id}/scim/v2/Groups/${id}`, {
      method: "PATCH",
      headers: f.headers,
      body: JSON.stringify(body),
    });
  expect((await group("one", {})).status).toBe(200);
  expect((await group("two", {})).status).toBe(200);
  expect((await group("three", {})).status).toBe(409);
  expect((await group("one", { displayName: "renamed" })).status).toBe(200);
  const excessive = await group("one", {
    Operations: [
      {
        op: "add",
        path: "members",
        value: Array.from({ length: 101 }, (_, i) => ({ value: `user-${i}` })),
      },
    ],
  });
  expect(excessive.status).toBe(400);
  expect((await excessive.json()).scimType).toBe("tooMany");
  expect(
    (await f.ctx.stores.scim.groups.getById(f.id, "one"))?.memberIds,
  ).toEqual([]);
});
