import { randomUUID } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { expect, it, vi } from "vitest";
import {
  createPgOwner,
  createRealPostgresContextWithMigrations,
} from "../../../database/tests/pg-harness-full.js";
import { createControlPlane } from "../create-app.js";
import { withScimOrganizationBoundary } from "../repos/scim-organization-boundary.js";
import { adoptSessionWithinCapacity } from "../routes/federated-session.js";
import {
  finishOrganizationWithdrawal,
  prepareRemovalWithdrawal,
  prepareRoleWithdrawal,
} from "../services/organization-withdrawal.js";

const migrations = fileURLToPath(
  new URL("../../../database/drizzle", import.meta.url),
);
const legacyIncarnation = "00000000-0000-4000-8000-000000000001";
const legacyRevision = "00000000-0000-4000-8000-000000000002";

it.skipIf(!process.env.DATABASE_URL)(
  "approves and withdraws pre-upgrade memberships without confusing other legacy owners",
  async () => {
    const url = process.env.DATABASE_URL?.trim();
    if (!url) throw new Error("DATABASE_URL is required");
    const before = mkdtempSync(join(tmpdir(), "os-control-plane-migration-"));
    cpSync(migrations, before, { recursive: true });
    const journalPath = join(before, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    journal.entries = journal.entries.filter(
      (entry: { idx: number }) => entry.idx < 34,
    );
    writeFileSync(journalPath, JSON.stringify(journal));
    const owner = createPgOwner(() =>
      createRealPostgresContextWithMigrations(url, before),
    );
    let plane: ReturnType<typeof createControlPlane> | undefined;
    try {
      const { db } = await owner.acquire();
      const first = randomUUID();
      const second = randomUUID();
      const organization = randomUUID();
      await db.execute(
        sql`INSERT INTO principals (id, state, assurance) VALUES (${first}, 'active', 'verified'), (${second}, 'active', 'verified')`,
      );
      await db.execute(
        sql`INSERT INTO organizations (id, slug, display_name, state, created_by) VALUES (${organization}, 'legacy-owners', 'Legacy owners', 'active', ${first})`,
      );
      await db.execute(
        sql`INSERT INTO organization_memberships (organization_id, principal_id, role) VALUES (${organization}, ${first}, 'owner'), (${organization}, ${second}, 'owner')`,
      );
      await migrate(db, { migrationsFolder: migrations });
      plane = createControlPlane({
        database: db,
        config: {
          port: 0,
          publicUrl: "http://localhost",
          issuer: "http://localhost",
          hostApiUrl: "http://localhost:8080",
          operatorToken: "migration-test-operator-token",
          claimPepper: "migration-test-claim-pepper-at-least-32-chars",
        },
        processEnv: {
          ...process.env,
          DATABASE_URL: "",
          OPENSESAME_EVENT_KEY:
            "migration-test-sealing-key-at-least-32-characters",
        },
      });
      await plane.ctx.securityRecoveryReady;
      const session = await adoptSessionWithinCapacity(
        plane.ctx,
        first,
        "migration-test",
      );
      const requests: Array<{ path: string; body: JsonObject }> = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const body: BoundaryValue = overlapCast(JSON.parse(String(init?.body)));
        if (!isJsonObject(body)) {
          throw new Error("Host fetch body is not a JSON object");
        }
        requests.push({ path: new URL(String(input)).pathname, body });
        return Response.json({ ok: true });
      });
      const approval = await plane.app.request("/v1/device/approve", {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          user_code: "ABCD-EFGH",
          organization_id: organization,
        }),
      });
      expect(approval.status).toBe(200);
      expect(requests[0]).toMatchObject({
        path: "/api/v1/device/approve",
        body: {
          principal: first,
          organization_id: organization,
          membership_incarnation: legacyIncarnation,
          authority_revision: legacyRevision,
        },
      });

      const input = {
        organizationId: organization,
        principalId: first,
        actorPrincipalId: second,
        actorType: "human" as const,
        correlationId: "legacy-role",
      };
      const prepared = await withScimOrganizationBoundary(
        plane.ctx,
        organization,
        (tx) => prepareRoleWithdrawal(tx, { ...input, role: "member" }),
      );
      expect(prepared.status).toBe("ready");
      if (prepared.status !== "ready")
        throw new Error("expected role withdrawal");
      expect(
        (await finishOrganizationWithdrawal(plane.ctx, prepared.prepared))
          .status,
      ).toBe("changed");
      expect(requests[1]).toMatchObject({
        path: "/api/v1/sessions/revoke",
        body: {
          principal_id: first,
          organization_id: organization,
          membership_incarnation: legacyIncarnation,
          authority_revision: legacyRevision,
        },
      });

      const lastOwner = await withScimOrganizationBoundary(
        plane.ctx,
        organization,
        (tx) =>
          prepareRoleWithdrawal(tx, {
            ...input,
            principalId: second,
            role: "member",
          }),
      );
      expect(lastOwner.status).toBe("last_owner");
      const changed =
        await plane.ctx.stores.organizationMemberships.findVersioned(
          organization,
          first,
        );
      expect(changed?.authorityRevision).not.toBe(legacyRevision);
      const removal = await withScimOrganizationBoundary(
        plane.ctx,
        organization,
        (tx) => prepareRemovalWithdrawal(tx, input),
      );
      expect(removal.status).toBe("ready");
      if (removal.status !== "ready") throw new Error("expected removal");
      expect(
        (await finishOrganizationWithdrawal(plane.ctx, removal.prepared))
          .status,
      ).toBe("removed");
      expect(requests[2]).toMatchObject({
        path: "/api/v1/sessions/revoke",
        body: {
          principal_id: first,
          organization_id: organization,
          membership_incarnation: legacyIncarnation,
          authority_revision: changed?.authorityRevision,
        },
      });
      expect(
        (
          await plane.ctx.stores.organizationMemberships.findVersioned(
            organization,
            second,
          )
        )?.membership.role,
      ).toBe("owner");
    } finally {
      vi.restoreAllMocks();
      try {
        try {
          await plane?.withdrawalRecovery.stop();
        } finally {
          await owner.close();
        }
      } finally {
        rmSync(before, { recursive: true, force: true });
      }
    }
  },
  60_000,
);
