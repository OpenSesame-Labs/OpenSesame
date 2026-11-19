import { randomUUID } from "node:crypto";
import {
  MemoryOrganizationMembershipStore,
  PostgresOrganizationMembershipStore,
  createDrizzle,
  createSqlClient,
} from "@opensesame/database";
import { overlapCast } from "@opensesame/os-domain";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import { DurableMap } from "../repos/durable-map.js";
import { principalSessionEpoch } from "../repos/principal-session-boundary.js";
import { saveProvisional } from "../repos/session-storage.js";
import { adoptSessionWithinCapacity } from "../routes/federated-session.js";
import {
  ensurePersonalOrganization,
  revokeOrganizationMembership,
} from "../routes/organizations.js";

const databaseUrl = process.env.DATABASE_URL;

describe("memory membership revocation boundary", () => {
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
    vi.spyOn(MemoryOrganizationMembershipStore.prototype, "remove")
      .mockImplementationOnce(async function (...args) {
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
    ).toBe(401);

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
    const cleanupSpy = vi
      .spyOn(DurableMap.prototype, "entries")
      .mockImplementationOnce(
      async function () {
        throw new Error("session cleanup unavailable");
      },
      );
    await expect(
      revokeOrganizationMembership(first.ctx, {
        organizationId: rollbackMembership.organizationId,
        principalId: rollbackPerson.principalId,
        correlationId: "rollback",
        reason: "deprovisioned",
      }),
    ).rejects.toThrow("session cleanup unavailable");
    cleanupSpy.mockRestore();
    expect(
      await second.ctx.stores.organizationMemberships.find(
        rollbackMembership.organizationId,
        rollbackPerson.principalId,
      ),
    ).toBeDefined();
    expect(
      await principalSessionEpoch(second.ctx.stores, rollbackPerson.principalId),
    ).toBe(rollbackEpoch);
  }, 60_000);
});
