import { randomUUID } from "node:crypto";
import {
  MemoryOrganizationMembershipStore,
  PostgresOrganizationMembershipStore,
  createDrizzle,
  createSqlClient,
  principals,
} from "@opensesame/database";
import { overlapCast } from "@opensesame/os-domain";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import { DurableMap } from "../repos/durable-map.js";
import {
  principalSessionEpoch,
  withPrincipalSessionBoundary,
} from "../repos/principal-session-boundary.js";
import { saveProvisional } from "../repos/session-storage.js";
import { adoptSessionWithinCapacity } from "../routes/federated-session.js";
import {
  ensurePersonalOrganization,
  revokeOrganizationMembership,
  serializeMembershipMutation,
} from "../routes/organizations.js";
import {
  groupsPath,
  mintScimToken,
  patchScim,
  usersPath,
} from "./scim-test-helpers.js";

const databaseUrl = process.env.DATABASE_URL;

describe("memory membership revocation boundary", () => {
  it("takes the organization turn before the principal boundary", async () => {
    const started = createControlPlane({
      processEnv: { ...process.env, DATABASE_URL: "" },
    });
    const principalId = "prn_lock_order";
    const organizationId = "org:lock-order";
    let releaseOrganization = () => {};
    let organizationHeld = () => {};
    const held = new Promise<void>((resolve) => {
      organizationHeld = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseOrganization = resolve;
    });
    const ownerMutation = serializeMembershipMutation(
      started.ctx,
      organizationId,
      async () => {
        organizationHeld();
        await release;
      },
    );
    await held;

    const revoking = revokeOrganizationMembership(started.ctx, {
      organizationId,
      principalId,
      correlationId: "lock-order",
      reason: "deprovisioned",
    });
    await Promise.resolve();
    await withPrincipalSessionBoundary(
      started.ctx.stores,
      principalId,
      "revoke",
      async () => undefined,
    );

    releaseOrganization();
    await ownerMutation;
    await revoking;
  });

  it("refuses session publication while revocation is pending", async () => {
    const started = createControlPlane({
      processEnv: { ...process.env, DATABASE_URL: "" },
    });
    const response = await started.app.request("/v1/principals/provisional", {
      method: "POST",
    });
    const person: { principalId: string } = overlapCast(await response.json());
    const membership = await ensurePersonalOrganization(
      started.ctx,
      person.principalId,
    );
    let reached = () => {};
    let release = () => {};
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = MemoryOrganizationMembershipStore.prototype.remove;
    vi.spyOn(
      MemoryOrganizationMembershipStore.prototype,
      "remove",
    ).mockImplementationOnce(async function (...args) {
      const removed = original.apply(this, args);
      reached();
      await gate;
      return removed;
    });
    const revoking = revokeOrganizationMembership(started.ctx, {
      organizationId: membership.organizationId,
      principalId: person.principalId,
      correlationId: "memory-overlap",
      reason: "deprovisioned",
    });
    await paused;
    try {
      await expect(
        adoptSessionWithinCapacity(
          started.ctx,
          person.principalId,
          "during-removal",
        ),
      ).rejects.toThrow(/session authority changed/i);
    } finally {
      release();
    }
    await revoking;
  });
});

describe.skipIf(!databaseUrl)("replica membership revocation boundary", () => {
  let admin: ReturnType<typeof createSqlClient>;
  let connection: ReturnType<typeof createDrizzle>;
  let databaseName: string;
  let first: ReturnType<typeof createControlPlane>;
  let second: ReturnType<typeof createControlPlane>;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("Expected a test PostgreSQL URL");
    const url = new URL(databaseUrl);
    if (
      url.hash ||
      [...url.searchParams.keys()].some((key) =>
        ["database", "dbname", "db"].includes(key.toLowerCase()),
      )
    )
      throw new Error("Unsafe test PostgreSQL URL");
    databaseName = `session_boundary_${randomUUID().replaceAll("-", "")}`;
    admin = createSqlClient(databaseUrl);
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    url.pathname = `/${databaseName}`;
    connection = createDrizzle(url.toString());
    await migrate(connection.db, {
      migrationsFolder: new URL(
        "../../../../packages/database/drizzle",
        import.meta.url,
      ).pathname,
    });
    const options = {
      database: connection.db,
      config: {
        port: 0,
        publicUrl: "http://localhost",
        issuer: "http://localhost",
        claimPepper: "replica-session-test-pepper-32-chars",
      },
      processEnv: {
        ...process.env,
        DATABASE_URL: "",
        OPENSESAME_EVENT_KEY: "replica-session-test-sealing-key",
      },
    };
    first = createControlPlane(options);
    second = createControlPlane(options);
  }, 60_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    if (connection) await connection.sql.end();
    if (admin) {
      if (databaseName)
        await admin.unsafe(
          `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
        );
      await admin.end();
    }
  });

  it("routes root repository reads through the DurableMap transaction", async () => {
    const principalId = `prn_tx_${randomUUID()}`;
    const sessions = first.ctx.stores.provisionalSessions;
    if (!(sessions instanceof DurableMap))
      throw new Error("Expected durable sessions");

    await expect(
      sessions.transaction(async (database) => {
        await database.insert(principals).values({
          id: principalId,
          state: "active",
          assurance: "verified",
          version: 1,
          sessionAuthorityVersion: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        await expect(
          first.ctx.repos.principals.getById(principalId),
        ).resolves.toMatchObject({ id: principalId, state: "active" });
        throw new Error("rollback transaction context regression");
      }),
    ).rejects.toThrow("rollback transaction context regression");
    await expect(
      first.ctx.repos.principals.getById(principalId),
    ).resolves.toBeNull();
  });

  it("refuses publication on another replica while revocation commits", async () => {
    const response = await first.app.request("/v1/principals/provisional", {
      method: "POST",
    });

    expect(response.status).toBe(201);
    const person: { principalId: string; accessToken: string } = overlapCast(
      await response.json(),
    );
    const membership = await ensurePersonalOrganization(
      first.ctx,
      person.principalId,
    );
    const staleEpoch = await principalSessionEpoch(
      second.ctx.stores,
      person.principalId,
    );

    let reached = () => {};
    let release = () => {};
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = PostgresOrganizationMembershipStore.prototype.remove;
    const spy = vi
      .spyOn(PostgresOrganizationMembershipStore.prototype, "remove")
      .mockImplementationOnce(async function (...args) {
        const removed = await original.apply(this, args);
        reached();
        await gate;
        return removed;
      });

    const revoking = revokeOrganizationMembership(first.ctx, {
      organizationId: membership.organizationId,
      principalId: person.principalId,
      correlationId: "replica-overlap",
      reason: "deprovisioned",
    });
    await paused;
    try {
      expect(
        (
          await second.app.request("/v1/principals/me", {
            headers: { authorization: `Bearer ${person.accessToken}` },
          })
        ).status,
      ).toBe(401);
      await expect(
        adoptSessionWithinCapacity(
          second.ctx,
          person.principalId,
          "during-removal",
        ),
      ).rejects.toThrow(/session authority changed/i);
    } finally {
      release();
    }
    await revoking;
    spy.mockRestore();

    const now = second.ctx.clock();
    await expect(
      saveProvisional(
        second.ctx.stores,
        {
          id: `ps_${randomUUID()}`,
          principalId: person.principalId,
          quotaProfile: "anonymous",
          allowedActions: ["session.continue_anonymous"],
          createdAt: now,
          expiresAt: new Date(now.getTime() + 60_000),
        },
        `pst_${randomUUID()}`,
        staleEpoch,
      ),
    ).rejects.toThrow(/session authority changed/i);

    expect(
      (
        await second.app.request("/v1/principals/me", {
          headers: { authorization: `Bearer ${person.accessToken}` },
        })
      ).status,
    ).toBe(200);

    const rollbackResponse = await first.app.request(
      "/v1/principals/provisional",
      { method: "POST" },
    );
    const rollbackPerson: { principalId: string } = overlapCast(
      await rollbackResponse.json(),
    );
    const rollbackMembership = await ensurePersonalOrganization(
      first.ctx,
      rollbackPerson.principalId,
    );
    const rollbackEpoch = await principalSessionEpoch(
      first.ctx.stores,
      rollbackPerson.principalId,
    );
    const originalRemove = PostgresOrganizationMembershipStore.prototype.remove;
    const removalSpy = vi
      .spyOn(PostgresOrganizationMembershipStore.prototype, "remove")
      .mockImplementationOnce(async function (...args) {
        await originalRemove.apply(this, args);
        throw new Error("membership revocation interrupted");
      });
    await expect(
      revokeOrganizationMembership(first.ctx, {
        organizationId: rollbackMembership.organizationId,
        principalId: rollbackPerson.principalId,
        correlationId: "rollback",
        reason: "deprovisioned",
      }),
    ).rejects.toThrow("membership revocation interrupted");
    removalSpy.mockRestore();
    expect(
      await second.ctx.stores.organizationMemberships.find(
        rollbackMembership.organizationId,
        rollbackPerson.principalId,
      ),
    ).toBeDefined();
    expect(
      await principalSessionEpoch(
        second.ctx.stores,
        rollbackPerson.principalId,
      ),
    ).toBe(rollbackEpoch);

    const orderingResponse = await first.app.request(
      "/v1/principals/provisional",
      { method: "POST" },
    );
    const orderingPerson: { principalId: string } = overlapCast(
      await orderingResponse.json(),
    );
    const orderingMembership = await ensurePersonalOrganization(
      first.ctx,
      orderingPerson.principalId,
    );
    const orderingSessionId = `ps_${randomUUID()}`;
    let publicationReached = () => {};
    let releasePublication = () => {};
    const publicationPaused = new Promise<void>((resolve) => {
      publicationReached = resolve;
    });
    const publicationGate = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const publishing = withPrincipalSessionBoundary(
      first.ctx.stores,
      orderingPerson.principalId,
      "publish",
      async (stores) => {
        const createdAt = first.ctx.clock();
        await stores.provisionalSessions.set(orderingSessionId, {
          id: orderingSessionId,
          principalId: orderingPerson.principalId,
          quotaProfile: "anonymous",
          allowedActions: ["session.continue_anonymous"],
          createdAt,
          expiresAt: new Date(createdAt.getTime() + 60_000),
        });
        publicationReached();
        await publicationGate;
      },
    );
    await publicationPaused;
    let revocationSettled = false;
    const orderedRevocation = revokeOrganizationMembership(second.ctx, {
      organizationId: orderingMembership.organizationId,
      principalId: orderingPerson.principalId,
      correlationId: "publisher-first",
      reason: "deprovisioned",
    }).finally(() => {
      revocationSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(revocationSettled).toBe(false);
    releasePublication();
    await publishing;
    await orderedRevocation;
    expect(
      await first.ctx.stores.provisionalSessions.get(orderingSessionId),
    ).toMatchObject({ principalId: orderingPerson.principalId });
    expect(
      await first.ctx.stores.organizationMemberships.find(
        orderingMembership.organizationId,
        orderingPerson.principalId,
      ),
    ).toBeUndefined();
  }, 60_000);

  it("orders a SCIM role push against deactivation on another replica", async () => {
    await first.ctx.systemPrincipalReady;
    const response = await first.app.request("/v1/principals/provisional", {
      method: "POST",
    });
    expect(response.status).toBe(201);
    const person: { principalId: string; accessToken: string } = overlapCast(
      await response.json(),
    );
    const membership = await ensurePersonalOrganization(
      first.ctx,
      person.principalId,
    );
    const organization = await first.ctx.stores.organizations.get(
      membership.organizationId,
    );
    if (!organization) throw new Error("organization missing");
    await first.ctx.stores.organizations.set(organization.id, {
      ...organization,
      ssoIssuer: "https://scim-race.example",
    });
    await first.ctx.stores.organizationMemberships.upsert({
      organizationId: organization.id,
      principalId: first.ctx.systemOwnerPrincipalId,
      role: "owner",
      createdAt: first.ctx.clock(),
      updatedAt: first.ctx.clock(),
    });
    const subject = `subject-${randomUUID()}`;
    await first.ctx.repos.externalIdentities.create({
      id: `xid_${randomUUID()}`,
      principalId: person.principalId,
      kind: "oidc",
      issuer: "https://scim-race.example",
      subject,
      assurance: "verified",
      linkedAt: first.ctx.clock(),
      metadata: {},
    });
    const userId = `scim_${randomUUID()}`;
    await first.ctx.stores.scim.users.create({
      id: userId,
      organizationId: organization.id,
      userName: "race@example.test",
      externalId: subject,
      active: true,
      raw: {},
      createdAt: first.ctx.clock(),
      updatedAt: first.ctx.clock(),
    });
    await first.ctx.stores.scim.mappings.put(
      organization.id,
      "admins",
      "admin",
    );
    const { token } = await mintScimToken(
      first.app,
      organization.id,
      person.accessToken,
    );

    let reached = () => {};
    let release = () => {};
    const firstHost = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let hostCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.endsWith("/api/v1/sessions/revoke"))
        throw new Error(`unexpected fetch: ${url}`);
      hostCalls += 1;
      if (hostCalls === 1) {
        reached();
        await gate;
      }
      return new Response(JSON.stringify({ revoked: 1 }), { status: 200 });
    });
    const rolePush = patchScim(
      first.app,
      groupsPath(organization.id, "admins"),
      token,
      [{ op: "add", path: "members", value: [{ value: userId }] }],
    );
    await firstHost;
    const deactivated = await patchScim(
      second.app,
      usersPath(organization.id, `/${userId}`),
      token,
      [{ op: "replace", path: "active", value: false }],
    );
    expect(deactivated.status).toBe(200);
    release();
    expect((await rolePush).status).toBe(500);
    const finalUser = await second.ctx.stores.scim.users.getById(
      organization.id,
      userId,
    );
    expect(finalUser?.active).toBe(false);
    expect(
      await second.ctx.stores.organizationMemberships.find(
        organization.id,
        person.principalId,
      ),
    ).toBeUndefined();
  });
});
