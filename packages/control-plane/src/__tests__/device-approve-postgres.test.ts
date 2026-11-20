import { randomUUID } from "node:crypto";
import { createDrizzle, createSqlClient } from "@opensesame/database";
import { overlapCast } from "@opensesame/os-domain";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import { withScimOrganizationBoundary } from "../repos/scim-organization-boundary.js";
import { ensurePersonalOrganization } from "../routes/organizations.js";
import { prepareRemovalWithdrawal } from "../services/organization-withdrawal.js";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "replica device approval withdrawal boundary",
  () => {
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
      databaseName = `device_boundary_${randomUUID().replaceAll("-", "")}`;
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
          operatorToken: "replica-device-test-operator-token",
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

    it("refuses a device approval on another replica after withdrawal is prepared", async () => {
      await Promise.all([
        first.ctx.securityRecoveryReady,
        second.ctx.securityRecoveryReady,
      ]);
      const created = await first.app.request("/v1/principals/provisional", {
        method: "POST",
      });
      expect(created.status).toBe(201);
      const person: { principalId: string; accessToken: string } = overlapCast(
        await created.json(),
      );
      const membership = await ensurePersonalOrganization(
        first.ctx,
        person.principalId,
      );
      let prepared = () => {};
      let release = () => {};
      const entered = new Promise<void>((resolve) => {
        prepared = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const withdrawal = withScimOrganizationBoundary(
        first.ctx,
        membership.organizationId,
        async (tx) => {
          const result = await prepareRemovalWithdrawal(tx, {
            organizationId: membership.organizationId,
            principalId: person.principalId,
            actorPrincipalId: first.ctx.systemOwnerPrincipalId,
            actorType: "system",
            correlationId: "device-replica-overlap",
            reason: "scim_deactivated",
          });
          expect(result.status).toBe("ready");
          prepared();
          await gate;
        },
      );
      await entered;
      const host = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("{}"));
      const approval = second.app.request("/v1/device/approve", {
        method: "POST",
        headers: {
          authorization: `Bearer ${person.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          user_code: "ABCD-EFGH",
          organization_id: membership.organizationId,
        }),
      });
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
      } finally {
        release();
      }
      await withdrawal;
      const response = await approval;
      expect(response.status, await response.text()).toBe(403);
      expect(host).not.toHaveBeenCalled();
      host.mockRestore();
    }, 60_000);
  },
);
