import { randomUUID } from "node:crypto";
import {
  PostgresOrganizationMembershipStore,
  createDrizzle,
  createSqlClient,
} from "@opensesame/database";
import { overlapCast } from "@opensesame/os-domain";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import { DurableMap } from "../repos/durable-map.js";
import { resumePendingOrganizationRevocationAudits } from "../repos/organization-revocation-audit.js";
import { withPrincipalSessionBoundary } from "../repos/principal-session-boundary.js";
import { adoptSessionWithinCapacity } from "../routes/federated-session.js";
import { revokeOrganizationMembership } from "../routes/organization-revocation.js";
import { ensurePersonalOrganization } from "../routes/organizations.js";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)("replica session boundary on PostgreSQL", () => {
  let admin: ReturnType<typeof createSqlClient>;
  let connection: ReturnType<typeof createDrizzle>;
  let databaseName: string;
  let created = false;
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
    created = true;
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
    await Promise.all([
      first.ctx.securityRecoveryReady,
      second.ctx.securityRecoveryReady,
    ]);
  }, 60_000);
  afterAll(async () => {
    vi.restoreAllMocks();
    if (connection) await connection.sql.end();
    if (admin) {
      if (created)
        await admin.unsafe(
          `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
        );
      await admin.end();
    }
  });
  async function member() {
    const response = await first.app.request("/v1/principals/provisional", {
      method: "POST",
    });
    expect(response.status).toBe(201);
    const person: {
      principalId: string;
      accessToken: string;
    } = overlapCast(await response.json());
    const membership = await ensurePersonalOrganization(
      first.ctx,
      person.principalId,
    );
    const selected =
      await first.ctx.stores.organizationMemberships.findVersioned(
        membership.organizationId,
        person.principalId,
      );
    if (!selected) throw new Error("Expected membership");
    return { ...person, membership, incarnation: selected.incarnation };
  }
  it("serializes removals, blocks publication, and preserves a re-added member", async () => {
    const person = await member();
    let reached = () => {};
    let release = () => {};
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prototype = PostgresOrganizationMembershipStore.prototype;
    const remove = prototype.removeIfIncarnation;
    const spy = vi
      .spyOn(prototype, "removeIfIncarnation")
      .mockImplementationOnce(async function (...args) {
        const removed = await remove.apply(this, args);
        reached();
        await gate;
        return removed;
      });
    const input = {
      organizationId: person.membership.organizationId,
      principalId: person.principalId,
      correlationId: "replica-overlap",
      reason: "deprovisioned",
      expectedIncarnation: person.incarnation,
    };
    const one = revokeOrganizationMembership(first.ctx, input);
    await paused;
    const two = revokeOrganizationMembership(second.ctx, input);
    try {
      await expect(
        adoptSessionWithinCapacity(
          second.ctx,
          person.principalId,
          "during-removal",
        ),
      ).rejects.toThrow(/epoch/i);
    } finally {
      release();
    }
    const results = await Promise.all([one, two]);
    spy.mockRestore();
    expect(results.map((result) => result.membershipRemoved)).toEqual([
      true,
      false,
    ]);
    expect(
      (
        await second.app.request("/v1/principals/me", {
          headers: { authorization: `Bearer ${person.accessToken}` },
        })
      ).status,
    ).toBe(401);
    await second.ctx.stores.organizationMemberships.upsert(person.membership);
    const replacement = await adoptSessionWithinCapacity(
      second.ctx,
      person.principalId,
      "after-rejoin",
    );
    expect(
      (await revokeOrganizationMembership(first.ctx, input)).membershipRemoved,
    ).toBe(false);
    expect(
      (
        await first.app.request("/v1/principals/me", {
          headers: { authorization: `Bearer ${replacement.accessToken}` },
        })
      ).status,
    ).toBe(200);
  }, 60_000);
  it("rolls back membership and sessions when the audit intent cannot be saved", async () => {
    const person = await member();
    const audits = first.ctx.stores.organizationRevocationAudits;
    if (!(audits instanceof DurableMap))
      throw new Error("Expected durable audit store");
    const bind = audits.onDatabase.bind(audits);
    const spy = vi.spyOn(audits, "onDatabase").mockImplementationOnce((db) => {
      const bound = bind(db);
      vi.spyOn(bound, "set").mockRejectedValueOnce(
        new Error("audit intent unavailable"),
      );
      return bound;
    });
    await expect(
      revokeOrganizationMembership(first.ctx, {
        organizationId: person.membership.organizationId,
        principalId: person.principalId,
        correlationId: "rollback",
        reason: "deprovisioned",
      }),
    ).rejects.toThrow("audit intent unavailable");
    spy.mockRestore();
    expect(
      await second.ctx.stores.organizationMemberships.find(
        person.membership.organizationId,
        person.principalId,
      ),
    ).toBeDefined();
    expect(
      (
        await second.app.request("/v1/principals/me", {
          headers: { authorization: `Bearer ${person.accessToken}` },
        })
      ).status,
    ).toBe(200);
  }, 60_000);

  it("recovers an audit interrupted after the membership transaction commits", async () => {
    const person = await member();
    const append = first.ctx.repos.auditEvents.append.bind(
      first.ctx.repos.auditEvents,
    );
    const spy = vi
      .spyOn(first.ctx.repos.auditEvents, "append")
      .mockImplementation(async (event, uow) => {
        if (event.eventType === "organization.member_revoked")
          throw new Error("audit unavailable");
        return append(event, uow);
      });
    await expect(
      revokeOrganizationMembership(first.ctx, {
        organizationId: person.membership.organizationId,
        principalId: person.principalId,
        correlationId: "audit-recovery",
        reason: "deprovisioned",
      }),
    ).rejects.toThrow("audit unavailable");
    spy.mockRestore();
    expect(
      await second.ctx.stores.organizationMemberships.find(
        person.membership.organizationId,
        person.principalId,
      ),
    ).toBeUndefined();
    await resumePendingOrganizationRevocationAudits(second.ctx);
    await resumePendingOrganizationRevocationAudits(second.ctx);
    const events = await second.ctx.repos.auditEvents.list();
    expect(
      events.filter(
        (event) =>
          event.eventType === "organization.member_revoked" &&
          event.correlationId === "audit-recovery",
      ),
    ).toHaveLength(1);
  }, 60_000);

  it("releases a terminated replica's lock so sign-in can recover", async () => {
    const person = await member();
    let announce = (_pid: number) => {};
    let release = () => {};
    const ready = new Promise<number>((resolve) => {
      announce = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = withPrincipalSessionBoundary(
      first.ctx.stores,
      person.principalId,
      "revoke",
      async (stores) => {
        if (!(stores.provisionalSessions instanceof DurableMap))
          throw new Error("Expected durable sessions");
        await stores.provisionalSessions.transaction(async (db) => {
          const rows = await db.execute<{ pid: number }>(
            sql`SELECT pg_backend_pid() AS pid`,
          );
          const pid = rows[0]?.pid;
          if (!pid) throw new Error("Expected PostgreSQL backend id");
          announce(pid);
          await gate;
          await db.execute(sql`SELECT 1`);
        });
      },
    );
    const pid = await ready;
    try {
      const result =
        await connection.sql`SELECT pg_terminate_backend(${pid}) AS terminated`;
      expect(result[0]?.terminated).toBe(true);
    } finally {
      release();
    }
    await expect(held).rejects.toThrow();
    const adopted = await adoptSessionWithinCapacity(
      second.ctx,
      person.principalId,
      "after-terminated-replica",
    );
    expect(adopted.principalId).toBe(person.principalId);
  }, 60_000);
});
