import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { createPostgresOrganizationStores } from "../src/repos/postgres.js";
import { scimTokens } from "../src/schema/index.js";
import { scimGroupRoleMappings } from "../src/schema/scim-groups.js";
import { ScimAdminCapacityError } from "../src/scim-admin-limits.js";
import {
  type ScimStores,
  createMemoryScimStores,
  createPostgresScimStores,
} from "../src/scim-group-store.js";
import { makePrincipal } from "./factories.js";
import { createPgOwner } from "./pg-harness-full.js";

const owner = createPgOwner();
afterAll(() => owner.close());
const limits = {
  tokensPerOrganization: 2,
  tokensPerDeployment: 3,
  mappingsPerOrganization: 2,
  mappingsPerDeployment: 3,
};

async function exercise(
  a: ScimStores,
  b: ScimStores,
  first: string,
  second: string,
) {
  const attempts = await Promise.allSettled([
    a.tokens.mint(first, "hash-a"),
    b.tokens.mint(first, "hash-b"),
    a.tokens.mint(first, "hash-c"),
  ]);
  const accepted = attempts.filter((result) => result.status === "fulfilled");
  expect(accepted).toHaveLength(2);
  const refused = attempts.find((result) => result.status === "rejected");
  expect(refused?.status === "rejected" && refused.reason).toBeInstanceOf(
    ScimAdminCapacityError,
  );
  const records = await a.tokens.list(first);
  expect(records).toHaveLength(2);
  const old = records[0];
  const other = records[1];
  if (!old || !other) throw new Error("Expected two token records");
  expect(await a.tokens.purgeRevoked(first, old.id)).toBe(false);
  expect(await a.tokens.revoke(first, old.id)).toBe(true);
  await b.tokens.mint(first, "hash-rotated");
  expect(await a.tokens.count(first)).toBe(2);
  expect((await a.tokens.list(first)).some((row) => row.id === old.id)).toBe(
    false,
  );
  expect((await a.tokens.list(first)).some((row) => row.id === other.id)).toBe(
    true,
  );
  expect(await a.tokens.verify(first, "hash-rotated")).toBe(true);
  expect(await a.tokens.list(first, { startIndex: 2, count: 1 })).toHaveLength(
    1,
  );
  const moreTokens = await Promise.allSettled([
    a.tokens.mint(second, "hash-other-a"),
    b.tokens.mint(second, "hash-other-b"),
  ]);
  expect(
    moreTokens.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(await a.tokens.revoke(first, other.id)).toBe(true);
  expect(await b.tokens.purgeRevoked(first, other.id)).toBe(true);
  expect(await a.tokens.purgeRevoked(first, other.id)).toBe(false);

  await a.mappings.put(first, "one", "owner");
  await b.mappings.put(first, "two", "member");
  await expect(a.mappings.put(first, "three", "admin")).rejects.toBeInstanceOf(
    ScimAdminCapacityError,
  );
  expect(await a.mappings.removeIfNeutral(first, "one")).toBe(
    "mapping_not_neutral",
  );
  await b.mappings.put(first, "one", "member");
  expect(await a.mappings.removeIfNeutral(first, "one")).toBe("deleted");
  await a.mappings.put(first, "three", "admin");
  const more = await Promise.allSettled([
    a.mappings.put(second, "four", "member"),
    b.mappings.put(second, "five", "member"),
  ]);
  expect(more.filter((result) => result.status === "fulfilled")).toHaveLength(
    1,
  );
  expect(await b.mappings.count(first)).toBe(2);
  expect(
    await b.mappings.listByOrganization(first, { startIndex: 2, count: 1 }),
  ).toHaveLength(1);
  expect(await a.mappings.removeIfNeutral(first, "missing")).toBe("not_found");
}

it("bounds local tokens and mappings while preserving rotation and retirement", async () => {
  const stores = createMemoryScimStores(undefined, undefined, limits);
  await exercise(stores, stores, "org-one", "org-two");
});

it("atomically bounds tokens and mappings across Postgres store instances", async () => {
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
    createPostgresScimStores(db, undefined, undefined, limits),
    createPostgresScimStores(db, undefined, undefined, limits),
    first,
    second,
  );
  const legacy = `org_${randomUUID()}`;
  const now = new Date();
  await organizations.organizations.set(legacy, {
    id: legacy,
    slug: legacy,
    displayName: legacy,
    state: "active",
    createdBy: principal.id,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(scimTokens).values(
    Array.from({ length: 105 }, (_, index) => ({
      id: `legacy-token-${String(index).padStart(3, "0")}`,
      organizationId: legacy,
      tokenHash: `legacy-hash-${index}`,
      createdAt: now,
      revokedAt: index === 104 ? now : null,
    })),
  );
  await db.insert(scimGroupRoleMappings).values(
    Array.from(
      { length: 105 },
      (_, index): typeof scimGroupRoleMappings.$inferInsert => ({
        organizationId: legacy,
        groupId: `legacy-group-${String(index).padStart(3, "0")}`,
        role: "member",
        createdAt: now,
        updatedAt: now,
      }),
    ),
  );
  const legacyStores = createPostgresScimStores(
    db,
    undefined,
    undefined,
    limits,
  );
  expect(await legacyStores.tokens.count(legacy)).toBe(105);
  expect(await legacyStores.tokens.list(legacy)).toHaveLength(100);
  expect(
    await legacyStores.tokens.list(legacy, { startIndex: 101, count: 100 }),
  ).toHaveLength(5);
  expect(
    await legacyStores.tokens.purgeRevoked(legacy, "legacy-token-104"),
  ).toBe(true);
  expect(await legacyStores.mappings.count(legacy)).toBe(105);
  expect(await legacyStores.mappings.listByOrganization(legacy)).toHaveLength(
    100,
  );
  expect(
    await legacyStores.mappings.listByOrganization(legacy, {
      startIndex: 101,
      count: 100,
    }),
  ).toHaveLength(5);
  expect(
    await legacyStores.mappings.removeIfNeutral(legacy, "legacy-group-104"),
  ).toBe("deleted");
}, 60_000);
