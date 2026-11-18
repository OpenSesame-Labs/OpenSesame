import { randomUUID } from "node:crypto";
import type { ByoUpstream, Organization } from "@opensesame/os-domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MemoryRepositories,
  PostgresRepositories,
  type Repositories,
  WebhookEndpointLimitError,
} from "../src/index.js";
import { createPostgresOrganizationStores } from "../src/repos/postgres.js";
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
const engines = [
  { name: "memory", repos: (): Repositories => new MemoryRepositories() },
  { name: "postgres", repos: (): Repositories => pg.repos },
];
describe.each(engines)("$name webhook quota", ({ repos: getRepos }) => {
  it("atomically caps concurrent registrations and frees deleted capacity", async () => {
    const repos = getRepos();
    const owner = await repos.principals.create(makePrincipal());
    const create = () =>
      repos.webhookEndpoints.create({
        id: `whep_${randomUUID()}`,
        principalId: owner.id,
        url: "https://hooks.example.test",
        secret: "whsec_test",
        createdAt: new Date(),
      });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 24 }, create),
    );
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(10);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected")
        expect(outcome.reason).toBeInstanceOf(WebhookEndpointLimitError);
    }
    const rows = await repos.webhookEndpoints.listForPrincipal(owner.id);
    expect(rows).toHaveLength(10);
    const first = rows[0];
    if (!first) throw new Error("Missing registered endpoint");
    await repos.webhookEndpoints.deleteById(first.id);
    await expect(create()).resolves.toMatchObject({ principalId: owner.id });
  });
  it("rolls back an over-capacity transaction before applying any writes", async () => {
    const repos = getRepos();
    const owner = await repos.principals.create(makePrincipal());
    await expect(
      repos.transaction(async (uow) => {
        for (let index = 0; index < 11; index += 1) {
          await repos.webhookEndpoints.create(
            {
              id: `whep_${randomUUID()}`,
              principalId: owner.id,
              url: "https://hooks.example.test",
              secret: "whsec_test",
              createdAt: new Date(),
            },
            uow,
          );
        }
      }),
    ).rejects.toBeInstanceOf(WebhookEndpointLimitError);
    expect(
      await repos.webhookEndpoints.listForPrincipal(owner.id),
    ).toHaveLength(0);
  });
  it("rejects a competing transaction without partially applying it", async () => {
    if (!(getRepos() instanceof MemoryRepositories)) return;
    const repos = new MemoryRepositories();
    const owner = await repos.principals.create(makePrincipal());
    let release = () => {};
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let staged = 0;
    const transaction = () =>
      repos.transaction(async (uow) => {
        for (let index = 0; index < 6; index += 1) {
          await repos.webhookEndpoints.create(
            {
              id: `whep_${randomUUID()}`,
              principalId: owner.id,
              url: "https://hooks.example.test",
              secret: "whsec_test",
              createdAt: new Date(),
            },
            uow,
          );
        }
        staged += 1;
        if (staged === 2) release();
        await ready;
      });
    const outcomes = await Promise.allSettled([transaction(), transaction()]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      await repos.webhookEndpoints.listForPrincipal(owner.id),
    ).toHaveLength(6);
  });
});

function upstream(suffix: string): ByoUpstream {
  return {
    id: `byo_${randomUUID()}`,
    issuer: `https://${suffix}-${randomUUID()}.example`,
    label: "Capacity",
    clientId: `client-${suffix}`,
    clientAuth: "none",
    registrationSource: "manual",
    state: "active",
    createdAt: new Date("2026-08-24T09:00:00.000Z"),
  };
}

function scimUser(organizationId: string, suffix: string): ScimUserRecord {
  const now = new Date("2026-08-24T09:00:00.000Z");
  return {
    id: `scim_${randomUUID()}`,
    organizationId,
    userName: `${suffix}-${randomUUID()}@example.test`,
    active: true,
    raw: {},
    createdAt: now,
    updatedAt: now,
  };
}

describe.each(engines)(
  "$name durable capacity admission",
  ({ repos: getRepos }) => {
    it("checks duplicates before reporting BYO capacity", async () => {
      const repository = getRepos().byoUpstreams;
      const first = upstream("duplicate");
      const limit = (await repository.count()) + 1;
      await repository.createWithinLimit(first, limit);
      await expect(
        repository.createWithinLimit(
          { ...upstream("other"), issuer: first.issuer },
          limit,
        ),
      ).rejects.toThrow(/already registered/);
      await expect(
        repository.createWithinLimit(upstream("full"), limit),
      ).resolves.toBeNull();
    });

    it("checks duplicates before reporting SCIM capacity", async () => {
      const repos = getRepos();
      const stores =
        repos instanceof MemoryRepositories
          ? createMemoryScimStores()
          : createPostgresScimStores(pg.db);
      const orgId = `org_${randomUUID()}`;
      if (!(repos instanceof MemoryRepositories)) {
        const principal = await pg.repos.principals.create(makePrincipal());
        const now = new Date("2026-08-24T09:00:00.000Z");
        await createPostgresOrganizationStores(pg.db).organizations.set(orgId, {
          id: orgId,
          slug: `capacity-${randomUUID()}`,
          displayName: "Capacity",
          state: "active",
          createdBy: principal.id,
          createdAt: now,
          updatedAt: now,
        });
      }
      const first = scimUser(orgId, "duplicate");
      await stores.users.createWithinLimit(first, 1);
      await expect(
        stores.users.createWithinLimit(
          { ...scimUser(orgId, "other"), userName: first.userName },
          1,
        ),
      ).rejects.toThrow(/already exists/);
      await expect(
        stores.users.createWithinLimit(scimUser(orgId, "full"), 1),
      ).resolves.toBeNull();
    });
  },
);

describe("postgres cross-process capacity admission", () => {
  it("admits only one concurrent SCIM creator", async () => {
    const principal = await pg.repos.principals.create(makePrincipal());
    const now = new Date("2026-08-24T09:00:00.000Z");
    const organization: Organization = {
      id: `org_${randomUUID()}`,
      slug: `capacity-${randomUUID()}`,
      displayName: "Capacity",
      state: "active",
      createdBy: principal.id,
      createdAt: now,
      updatedAt: now,
    };
    await createPostgresOrganizationStores(pg.db).organizations.set(
      organization.id,
      organization,
    );
    const first = createPostgresScimStores(pg.db);
    const second = createPostgresScimStores(pg.db);
    const results = await Promise.all([
      first.users.createWithinLimit(scimUser(organization.id, "first"), 1),
      second.users.createWithinLimit(scimUser(organization.id, "second"), 1),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await first.users.countByOrganization(organization.id)).toBe(1);
  });

  it("admits only one concurrent BYO creator", async () => {
    const first = pg.repos.byoUpstreams;
    const second = new PostgresRepositories(pg.db).byoUpstreams;
    const limit = (await first.count()) + 1;
    const results = await Promise.all([
      first.createWithinLimit(upstream("first"), limit),
      second.createWithinLimit(upstream("second"), limit),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await first.count()).toBe(limit);
  });
});
