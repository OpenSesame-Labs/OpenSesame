import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { createPostgresOrganizationStores } from "../src/repos/postgres.js";
import {
  SCIM_GROUP_MEMBERS_MAX,
  ScimGroupCapacityError,
  ScimGroupPayloadError,
} from "../src/scim-group-limits.js";
import {
  type ScimStores as GroupStores,
  createMemoryScimStores as memoryWithGroups,
  createPostgresScimStores as postgresWithGroups,
} from "../src/scim-group-store.js";
import {
  type ScimStores,
  type ScimUserRecord,
  createMemoryScimStores,
  createPostgresScimStores,
} from "../src/scim-store.js";
import {
  SCIM_USER_RAW_MAX_BYTES,
  ScimUserCapacityError,
  ScimUserPayloadError,
} from "../src/scim-user-limits.js";
import { makePrincipal } from "./factories.js";
import { createPgOwner } from "./pg-harness-full.js";

const limits = { perOrganization: 2, perDeployment: 3 };
const owner = createPgOwner();
afterAll(() => owner.close());

function user(organizationId: string, id: string): ScimUserRecord {
  return {
    id,
    organizationId,
    userName: `${id}@example.test`,
    active: true,
    raw: {},
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

async function exercise(
  a: ScimStores,
  b: ScimStores,
  first: string,
  second: string,
) {
  const initial = await Promise.allSettled([
    a.users.create(user(first, "a")),
    b.users.create(user(first, "b")),
    a.users.create(user(first, "c")),
  ]);
  expect(initial.filter((r) => r.status === "fulfilled")).toHaveLength(2);
  const rejected = initial.find((r) => r.status === "rejected");
  expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
    ScimUserCapacityError,
  );

  const deployment = await Promise.allSettled([
    a.users.create(user(second, "d")),
    b.users.create(user(second, "e")),
  ]);
  expect(deployment.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const total = await a.users.listByOrganization(first, {
    startIndex: 1,
    count: 0,
  });
  expect(total).toEqual({ totalResults: 2, resources: [] });
  await expect(
    a.users.listByOrganization(first, { startIndex: 1, count: 101 }),
  ).rejects.toThrow("Invalid SCIM page");
  const one = await a.users.listByOrganization(first, {
    startIndex: 1,
    count: 1,
  });
  const two = await b.users.listByOrganization(first, {
    startIndex: 2,
    count: 1,
  });
  expect(one.totalResults).toBe(2);
  expect(two.totalResults).toBe(2);
  expect(one.resources).toHaveLength(1);
  expect(two.resources).toHaveLength(1);
  expect(one.resources[0]?.id).not.toBe(two.resources[0]?.id);
  expect(
    (await a.users.listByOrganization(first, { startIndex: 3, count: 1 }))
      .resources,
  ).toEqual([]);

  const existing = one.resources[0];
  if (!existing) throw new Error("Expected a provisioned user");
  await b.users.update({ ...existing, active: false });
  expect((await a.users.findBySubject(first, existing.userName))?.active).toBe(
    false,
  );
  await expect(
    a.users.create(user(first, "after-deactivation")),
  ).rejects.toBeInstanceOf(ScimUserCapacityError);
  await expect(
    a.users.create({
      ...user(first, "oversized"),
      raw: { blob: "x".repeat(SCIM_USER_RAW_MAX_BYTES) },
    }),
  ).rejects.toBeInstanceOf(ScimUserPayloadError);
}

async function exerciseGroups(
  a: GroupStores,
  b: GroupStores,
  first: string,
  second: string,
) {
  const group = (organizationId: string, id: string) => ({
    id,
    organizationId,
    displayName: id,
    memberIds: ["user-a"],
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  });
  const attempts = await Promise.allSettled([
    a.groups.upsert(group(first, "g1")),
    b.groups.upsert(group(first, "g2")),
    a.groups.upsert(group(first, "g3")),
  ]);
  expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(2);
  const rejected = attempts.find((r) => r.status === "rejected");
  expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
    ScimGroupCapacityError,
  );
  const more = await Promise.allSettled([
    a.groups.upsert(group(second, "g4")),
    b.groups.upsert(group(second, "g5")),
  ]);
  expect(more.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const existing = (await a.groups.listByOrganization(first))[0];
  if (!existing) throw new Error("Expected a provisioned group");
  await expect(
    a.groups.upsert({
      ...existing,
      memberIds: Array.from(
        { length: SCIM_GROUP_MEMBERS_MAX + 1 },
        (_, index) => `member-${index}`,
      ),
    }),
  ).rejects.toBeInstanceOf(ScimGroupPayloadError);
  await b.groups.upsert({
    ...existing,
    displayName: "updated",
    memberIds: ["user-b"],
  });
  expect(
    (await a.groups.listByMember(first, "user-b")).map((row) => row.id),
  ).toEqual([existing.id]);
  expect(await a.groups.listByMember(first, "user-a")).toHaveLength(1);
}

it("enforces user capacity and stable bounded pages in local storage", async () => {
  const stores = createMemoryScimStores(limits);
  await exercise(stores, stores, "org-one", "org-two");
  const groups = memoryWithGroups(undefined, limits);
  await exerciseGroups(groups, groups, "org-one", "org-two");
});

it("shares user capacity atomically across Postgres store instances", async () => {
  const { db, repos } = await owner.acquire();
  const principal = await repos.principals.create(makePrincipal());
  const organizations = createPostgresOrganizationStores(db);
  const first = `org_${randomUUID()}`;
  const second = `org_${randomUUID()}`;
  for (const id of [first, second]) {
    const now = new Date();
    await organizations.organizations.set(id, {
      id,
      slug: id,
      displayName: id,
      state: "active",
      createdBy: principal.id,
      createdAt: now,
      updatedAt: now,
    });
  }
  await exercise(
    createPostgresScimStores(db, limits),
    createPostgresScimStores(db, limits),
    first,
    second,
  );
  await exerciseGroups(
    postgresWithGroups(db, undefined, limits),
    postgresWithGroups(db, undefined, limits),
    first,
    second,
  );
}, 60_000);
