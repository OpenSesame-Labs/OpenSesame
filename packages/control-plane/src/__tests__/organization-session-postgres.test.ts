import { randomUUID } from "node:crypto";
import {
  PostgresOrganizationMembershipStore,
  createDrizzle,
  createSqlClient,
} from "@opensesame/database";
import { overlapCast } from "@opensesame/os-domain";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import { adoptSessionWithinCapacity } from "../routes/federated-session.js";
import {
  ensurePersonalOrganization,
  revokeOrganizationMembership,
} from "../routes/organizations.js";

const databaseUrl = process.env.DATABASE_URL;

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

    expect(
      (
        await second.app.request("/v1/principals/me", {
          headers: { authorization: `Bearer ${person.accessToken}` },
        })
      ).status,
    ).toBe(401);
  }, 60_000);
});
