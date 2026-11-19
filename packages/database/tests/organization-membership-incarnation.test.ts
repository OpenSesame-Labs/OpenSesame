import { randomUUID } from "node:crypto";
import {
  type Organization,
  type OrganizationMembership,
  overlapCast,
} from "@opensesame/os-domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  OrganizationMembershipStore,
  OrganizationStores,
  Repositories,
} from "../src/repos/interfaces.js";
import {
  MemoryOrganizationMembershipStore,
  MemoryRepositories,
  createMemoryOrganizationStores,
} from "../src/repos/memory.js";
import {
  PostgresOrganizationMembershipStore,
  createPostgresOrganizationStores,
} from "../src/repos/postgres.js";
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

interface Backend {
  repos: Repositories;
  stores: OrganizationStores;
}

async function seedMembership(
  backend: Backend,
): Promise<OrganizationMembership> {
  const principal = await backend.repos.principals.create(makePrincipal());
  const now = new Date("2026-08-24T09:00:00.000Z");
  const organization: Organization = {
    id: `org_${randomUUID()}`,
    slug: `org-${randomUUID()}`,
    displayName: "Example",
    state: "active",
    createdBy: principal.id,
    createdAt: now,
    updatedAt: now,
  };
  await backend.stores.organizations.set(organization.id, organization);
  return {
    organizationId: organization.id,
    principalId: principal.id,
    role: "member",
    createdAt: now,
    updatedAt: now,
  };
}

const backends = [
  {
    name: "memory",
    create: (): Backend => ({
      repos: new MemoryRepositories(),
      stores: createMemoryOrganizationStores(),
    }),
  },
  {
    name: "SQL",
    create: (): Backend => ({
      repos: pg.repos,
      stores: createPostgresOrganizationStores(pg.db),
    }),
  },
];

describe.each(backends)("$name membership incarnation", ({ create }) => {
  it("preserves the incarnation on upsert without exposing it in membership rows", async () => {
    const backend = create();
    const row = await seedMembership(backend);
    const store = backend.stores.organizationMemberships;
    expect(
      await store.findVersioned(row.organizationId, row.principalId),
    ).toBeUndefined();
    await store.upsert(row);
    const initial = await store.findVersioned(
      row.organizationId,
      row.principalId,
    );
    if (!initial) throw new Error("expected membership");
    expect(initial.membership).toEqual(row);
    expect(initial.incarnation).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // Even a caller-supplied createdAt change is an update, not a new row.
    const updated: OrganizationMembership = {
      ...row,
      role: "owner",
      createdAt: new Date("2026-08-25T09:00:00.000Z"),
      updatedAt: new Date("2026-08-26T09:00:00.000Z"),
    };
    expect(await store.upsert(updated)).toEqual(updated);
    const afterUpdate = await store.findVersioned(
      row.organizationId,
      row.principalId,
    );
    expect(afterUpdate).toEqual({
      membership: updated,
      incarnation: initial.incarnation,
      authorityRevision: expect.any(String),
    });
    expect(afterUpdate?.authorityRevision).not.toBe(initial.authorityRevision);
    await store.upsert(updated);
    expect(
      await store.findVersioned(row.organizationId, row.principalId),
    ).toEqual(afterUpdate);
    expect(await store.listVersionedByOrganization(row.organizationId)).toEqual(
      [afterUpdate],
    );
    const rows = [
      await store.find(row.organizationId, row.principalId),
      ...(await store.listByOrganization(row.organizationId)),
      ...(await store.listByPrincipal(row.principalId)),
    ];
    for (const returned of rows) {
      expect(returned).toEqual(updated);
      expect(returned).not.toHaveProperty("incarnation");
      expect(returned).not.toHaveProperty("authorityRevision");
      expect(JSON.stringify(returned)).not.toContain(initial.incarnation);
    }
  });

  it("cannot remove an identical row that was deleted and added again", async () => {
    const backend = create();
    const row = await seedMembership(backend);
    const store = backend.stores.organizationMemberships;
    await store.upsert(row);
    const first = await store.findVersioned(
      row.organizationId,
      row.principalId,
    );
    if (!first) throw new Error("expected membership");
    expect(await store.remove(row.organizationId, row.principalId)).toBe(true);
    await store.upsert(row);
    const replacement = await store.findVersioned(
      row.organizationId,
      row.principalId,
    );
    if (!replacement) throw new Error("expected replacement membership");
    expect(replacement.incarnation).not.toBe(first.incarnation);
    expect(replacement.membership).toEqual(first.membership);
    expect(
      await store.removeIfIncarnation(
        row.organizationId,
        row.principalId,
        first.incarnation,
      ),
    ).toBe(false);
    expect(await store.find(row.organizationId, row.principalId)).toEqual(row);
    expect(
      await store.removeIfIncarnation(
        row.organizationId,
        row.principalId,
        "invalid",
      ),
    ).toBe(false);
    expect(
      await store.removeIfIncarnation(
        row.organizationId,
        row.principalId,
        replacement.incarnation,
      ),
    ).toBe(true);
    expect(
      await store.removeIfIncarnation(
        row.organizationId,
        row.principalId,
        replacement.incarnation,
      ),
    ).toBe(false);
    expect(
      await store.find(row.organizationId, row.principalId),
    ).toBeUndefined();
  });

  it("binds the token to both membership keys", async () => {
    const backend = create();
    const first = await seedMembership(backend);
    const second = await seedMembership(backend);
    const store: OrganizationMembershipStore =
      backend.stores.organizationMemberships;
    await store.upsert(first);
    await store.upsert(second);
    const observed = await store.findVersioned(
      first.organizationId,
      first.principalId,
    );
    if (!observed) throw new Error("expected membership");
    expect(
      await store.removeIfIncarnation(
        second.organizationId,
        second.principalId,
        observed.incarnation,
      ),
    ).toBe(false);
    expect(await store.find(second.organizationId, second.principalId)).toEqual(
      second,
    );
  });

  it("does not permit caller-owned records to mutate stored authority", async () => {
    const backend = create();
    const row = await seedMembership(backend);
    const store = backend.stores.organizationMemberships;
    await store.upsert(row);
    const observed = await store.findVersioned(
      row.organizationId,
      row.principalId,
    );
    if (!observed) throw new Error("expected membership");
    row.role = "owner";
    row.updatedAt.setUTCFullYear(2000);
    observed.membership.role = "admin";
    observed.membership.createdAt.setUTCFullYear(2001);
    const current = await store.findVersioned(
      row.organizationId,
      row.principalId,
    );
    expect(current?.membership.role).toBe("member");
    expect(current?.membership.createdAt.toISOString()).toBe(
      "2026-08-24T09:00:00.000Z",
    );
    expect(current?.membership.updatedAt.toISOString()).toBe(
      "2026-08-24T09:00:00.000Z",
    );
    expect(current?.authorityRevision).toBe(observed.authorityRevision);
  });
});

describe("memory membership Map compatibility", () => {
  it("tracks iterable construction, direct updates, deletion, and clear", () => {
    const row: OrganizationMembership = {
      organizationId: "org-1",
      principalId: "principal-1",
      role: "member",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const key = `${row.organizationId}:${row.principalId}`;
    const store = new MemoryOrganizationMembershipStore([[key, row]]);
    const first = store.findVersioned(row.organizationId, row.principalId);
    if (!first) throw new Error("expected membership");
    expect([...store]).toEqual([[key, row]]);
    expect(Object.keys(store)).toEqual([]);
    store.set(key, { ...row, role: "admin" });
    expect(
      store.findVersioned(row.organizationId, row.principalId)?.incarnation,
    ).toBe(first.incarnation);
    expect(store.delete(key)).toBe(true);
    store.set(key, row);
    const second = store.findVersioned(row.organizationId, row.principalId);
    expect(second?.incarnation).not.toBe(first.incarnation);
    store.clear();
    expect(
      store.findVersioned(row.organizationId, row.principalId),
    ).toBeUndefined();
    store.set(key, row);
    expect(
      store.findVersioned(row.organizationId, row.principalId)?.incarnation,
    ).not.toBe(second?.incarnation);
  });
});

describe("SQL membership transactions", () => {
  it("rolls back a transaction-bound conditional removal", async () => {
    const backend = {
      repos: pg.repos,
      stores: createPostgresOrganizationStores(pg.db),
    };
    const row = await seedMembership(backend);
    const store = backend.stores.organizationMemberships;
    await store.upsert(row);
    const observed = await store.findVersioned(
      row.organizationId,
      row.principalId,
    );
    if (!observed) throw new Error("expected membership");
    await expect(
      pg.db.transaction(async (tx) => {
        const bound = new PostgresOrganizationMembershipStore(overlapCast(tx));
        expect(
          await bound.removeIfIncarnation(
            row.organizationId,
            row.principalId,
            observed.incarnation,
          ),
        ).toBe(true);
        throw new Error("abort transaction");
      }),
    ).rejects.toThrow("abort transaction");
    expect(
      await store.findVersioned(row.organizationId, row.principalId),
    ).toEqual(observed);
  });

  it.skipIf(!process.env.DATABASE_URL)(
    "rejects a stale token after another Postgres connection replaces the row",
    async () => {
      const backend = {
        repos: pg.repos,
        stores: createPostgresOrganizationStores(pg.db),
      };
      const row = await seedMembership(backend);
      const store = backend.stores.organizationMemberships;
      await store.upsert(row);
      await pg.db.transaction(async (tx) => {
        const bound = new PostgresOrganizationMembershipStore(overlapCast(tx));
        const observed = await bound.findVersioned(
          row.organizationId,
          row.principalId,
        );
        if (!observed) throw new Error("expected membership");
        // The transaction owns one pool connection, so these writes use another.
        expect(await store.remove(row.organizationId, row.principalId)).toBe(
          true,
        );
        await store.upsert(row);
        expect(
          await bound.removeIfIncarnation(
            row.organizationId,
            row.principalId,
            observed.incarnation,
          ),
        ).toBe(false);
      });
      expect(await store.find(row.organizationId, row.principalId)).toEqual(
        row,
      );
    },
  );
});
