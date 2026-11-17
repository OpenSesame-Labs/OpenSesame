import { randomUUID } from "node:crypto";
import { type Organization, overlapCast } from "@opensesame/os-domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictError } from "../src/repos/interfaces.js";
import {
  MemoryRepositories,
  createMemoryOrganizationStores,
} from "../src/repos/memory.js";
import { createPostgresOrganizationStores } from "../src/repos/postgres.js";
import { scimUsers } from "../src/schema/index.js";
import {
  type ScimUserRecord,
  createMemoryScimStores,
  createPostgresScimStores,
} from "../src/scim-store.js";
import { makePrincipal } from "./factories.js";
import { type PgTestContext, createPgOwner } from "./pg-harness-full.js";

const pgOwner = createPgOwner();
let pg: PgTestContext;
beforeAll(async () => {
  pg = await pgOwner.acquire();
}, 60_000);
afterAll(async () => {
  await pgOwner.close();
});

async function memoryFixture() {
  const repos = new MemoryRepositories();
  const principal = await repos.principals.create(makePrincipal());
  const stores = createMemoryOrganizationStores();
  const org = organization(principal.id);
  await stores.organizations.set(org.id, org);
  return { store: createMemoryScimStores().users, row: user(org.id) };
}

async function postgresFixture() {
  const principal = await pg.repos.principals.create(makePrincipal());
  const org = organization(principal.id);
  await createPostgresOrganizationStores(pg.db).organizations.set(org.id, org);
  return { store: createPostgresScimStores(pg.db).users, row: user(org.id) };
}

function organization(createdBy: string): Organization {
  const now = new Date("2026-08-24T09:00:00.000Z");
  return {
    id: `org_${randomUUID()}`,
    slug: `org-${randomUUID()}`,
    displayName: "Example",
    state: "active",
    createdBy,
    createdAt: now,
    updatedAt: now,
  };
}

function user(organizationId: string): ScimUserRecord {
  const now = new Date("2026-08-24T09:00:00.000Z");
  return {
    id: `scim_${randomUUID()}`,
    organizationId,
    userName: "member@example.com",
    active: true,
    raw: { source: { label: "directory" } },
    createdAt: now,
    updatedAt: now,
  };
}

describe.each([
  { name: "memory", fixture: memoryFixture },
  { name: "SQL", fixture: postgresFixture },
])("$name SCIM revisions", ({ fixture }) => {
  it("paginates inactive users across organizations without skipping rows", async () => {
    const { store, row } = await fixture();
    for (const suffix of ["c", "a", "b", "active"]) {
      await store.create({
        ...row,
        id: `${row.id}-${suffix}`,
        userName: `${suffix}@example.com`,
        active: suffix === "active",
      });
    }
    const found: string[] = [];
    let cursor: string | undefined;
    while (true) {
      const page = await store.listInactiveForRecovery(cursor, 2);
      for (const entry of page)
        if (entry.organizationId === row.organizationId) found.push(entry.id);
      if (page.length < 2) break;
      cursor = page[page.length - 1]?.id;
    }
    expect(found).toEqual([`${row.id}-a`, `${row.id}-b`, `${row.id}-c`]);
  });

  it("compares the whole row by revision even when timestamps do not advance", async () => {
    const { store, row } = await fixture();
    expect(await store.getVersioned(row.organizationId, row.id)).toBeNull();
    expect(await store.create(row)).toEqual(row);
    const first = await store.getVersioned(row.organizationId, row.id);
    if (!first) throw new Error("expected SCIM user");
    const next: ScimUserRecord = {
      ...first.user,
      active: false,
      raw: { source: "deactivated", journal: ["principal-1"] },
    };
    const changed = await store.replaceIfRevision(
      row.organizationId,
      row.id,
      first.revision,
      next,
    );
    expect(changed?.user).toEqual(next);
    expect(changed?.revision).not.toBe(first.revision);
    expect(
      await store.replaceIfRevision(
        row.organizationId,
        row.id,
        first.revision,
        row,
      ),
    ).toBeUndefined();
    expect(
      await store.replaceIfRevision(row.organizationId, row.id, "invalid", row),
    ).toBeUndefined();
    expect(await store.getById(row.organizationId, row.id)).toEqual(next);
    expect(await store.getById("different-org", row.id)).toBeNull();
    expect(await store.getVersioned("different-org", row.id)).toBeNull();
    for (const publicUser of [
      await store.getById(row.organizationId, row.id),
      await store.findByUserName(row.organizationId, row.userName),
      ...(await store.listByOrganization(row.organizationId)),
    ]) {
      expect(publicUser).not.toHaveProperty("revision");
    }
  });

  it("lets exactly one concurrent replacement win and invalidates revisions on legacy updates", async () => {
    const { store, row } = await fixture();
    await store.create(row);
    const initial = await store.getVersioned(row.organizationId, row.id);
    if (!initial) throw new Error("expected SCIM user");
    const candidates = await Promise.all([
      store.replaceIfRevision(row.organizationId, row.id, initial.revision, {
        ...row,
        raw: { contender: 1 },
      }),
      store.replaceIfRevision(row.organizationId, row.id, initial.revision, {
        ...row,
        raw: { contender: 2 },
      }),
    ]);
    const winners = candidates.filter((candidate) => candidate !== undefined);
    expect(winners).toHaveLength(1);
    const winner = winners[0];
    if (!winner) throw new Error("expected one winner");
    expect(await store.getById(row.organizationId, row.id)).toEqual(
      winner.user,
    );
    await store.update(winner.user);
    const afterUpdate = await store.getVersioned(row.organizationId, row.id);
    expect(afterUpdate?.revision).not.toBe(winner.revision);
    expect(
      await store.replaceIfRevision(
        row.organizationId,
        row.id,
        winner.revision,
        row,
      ),
    ).toBeUndefined();
  });

  it("rejects identity changes and username conflicts without mutating either row", async () => {
    const { store, row } = await fixture();
    const other = {
      ...user(row.organizationId),
      userName: "other@example.com",
    };
    await store.create(row);
    await store.create(other);
    const first = await store.getVersioned(row.organizationId, row.id);
    if (!first) throw new Error("expected SCIM user");
    await expect(
      store.replaceIfRevision(row.organizationId, row.id, first.revision, {
        ...row,
        id: other.id,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      store.replaceIfRevision(row.organizationId, row.id, first.revision, {
        ...row,
        organizationId: "different-org",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      store.replaceIfRevision(row.organizationId, row.id, first.revision, {
        ...row,
        userName: other.userName,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      store.update({ ...row, userName: other.userName }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await store.getVersioned(row.organizationId, row.id)).toEqual(first);
    expect(await store.getById(other.organizationId, other.id)).toEqual(other);
  });

  it("does not allow caller-owned objects to change stored rows without a revision", async () => {
    const { store, row } = await fixture();
    await store.create(row);
    const initial = await store.getVersioned(row.organizationId, row.id);
    if (!initial) throw new Error("expected SCIM user");
    row.updatedAt.setUTCFullYear(2000);
    row.raw.source = "mutated input";
    initial.user.createdAt.setUTCFullYear(2001);
    initial.user.raw.source = "mutated result";
    const actual = await store.getVersioned(row.organizationId, row.id);
    expect(actual?.revision).toBe(initial.revision);
    expect(actual?.user.createdAt.toISOString()).toBe(
      "2026-08-24T09:00:00.000Z",
    );
    expect(actual?.user.updatedAt.toISOString()).toBe(
      "2026-08-24T09:00:00.000Z",
    );
    expect(actual?.user.raw).toEqual({ source: { label: "directory" } });
  });
});

it("rolls back transaction-bound SCIM replacements", async () => {
  const { store, row } = await postgresFixture();
  await store.create(row);
  const initial = await store.getVersioned(row.organizationId, row.id);
  if (!initial) throw new Error("expected SCIM user");
  await expect(
    pg.db.transaction(async (tx) => {
      const transactionStore = createPostgresScimStores(overlapCast(tx)).users;
      expect(
        await transactionStore.replaceIfRevision(
          row.organizationId,
          row.id,
          initial.revision,
          { ...row, active: false },
        ),
      ).toBeDefined();
      throw new Error("abort transaction");
    }),
  ).rejects.toThrow("abort transaction");
  expect(await store.getVersioned(row.organizationId, row.id)).toEqual(initial);
});

it("invalidates a revision when an older writer omits the revision column", async () => {
  const { store, row } = await postgresFixture();
  await store.create(row);
  const initial = await store.getVersioned(row.organizationId, row.id);
  if (!initial) throw new Error("expected SCIM user");
  await pg.db
    .update(scimUsers)
    .set({ active: false })
    .where(eq(scimUsers.id, row.id));
  const changed = await store.getVersioned(row.organizationId, row.id);
  expect(changed?.user.active).toBe(false);
  expect(changed?.revision).not.toBe(initial.revision);
  expect(
    await store.replaceIfRevision(
      row.organizationId,
      row.id,
      initial.revision,
      row,
    ),
  ).toBeUndefined();
});
