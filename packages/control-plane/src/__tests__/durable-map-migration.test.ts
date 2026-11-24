import { createHash } from "node:crypto";
import { serialize } from "node:v8";
import {
  type Database,
  type EventSealer,
  oidcLookup,
  sealOidcRow,
} from "@opensesame/database";
import * as schema from "@opensesame/database/schema";
import { overlapCast } from "@opensesame/os-domain";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import { resolveEventSealer } from "../event-sealing.js";
import { DurableMap } from "../repos/durable-map.js";
import {
  LegacySecurityRowsRemainError,
  rekeyLegacySecurityRows,
} from "../repos/security-map-rekey.js";
import { installDurableSecurityMaps } from "../repos/security-maps.js";
import type { PrincipalSessionFence } from "../security-state-types.js";
import { createAppStores } from "../state.js";
import { migratedPGlite, warmMigratedPGlite } from "./migrated-pglite.js";

vi.setConfig({ testTimeout: 60_000 });
beforeAll(warmMigratedPGlite, 60_000);

const claimPepper = "replica-test-only-claim-pepper-32chars";
// The sealer createControlPlane resolves for this pepper in the test env.
const sealer = resolveEventSealer(process.env, claimPepper, false);
const sha256 = (key: string) => createHash("sha256").update(key).digest("hex");
const EPOCHS = "OpenSesame:PrincipalSessionEpoch";
const AUDITS = "OpenSesame:OrganizationRevocationAudit";
const TOKENS = "OpenSesame:ProvisionalToken";
const soon = () => new Date(Date.now() + 60_000);

/** Exactly what the pre-2026-11-23 DurableMap wrote for a secret-keyed map. */
async function insertLegacy<T>(
  db: Database,
  model: string,
  key: string,
  value: T,
  expiresAt: Date | null = null,
) {
  await db.insert(schema.oidcPayloads).values({
    ...sealOidcRow(sealer, model, sha256(key), {
      value: serialize(value).toString("base64"),
    }),
    expiresAt,
  });
}

async function storedIds(db: Database, model: string) {
  const rows = await db
    .select({ id: schema.oidcPayloads.id })
    .from(schema.oidcPayloads)
    .where(eq(schema.oidcPayloads.model, model));
  return rows.map((row) => row.id).sort();
}

function secretMap<T>(
  db: Database,
  model: string,
  ttl: number | null = null,
  using: EventSealer = sealer,
) {
  return new DurableMap<T>(db, model, true, ttl, undefined, using);
}

async function withDatabase(run: (db: Database) => Promise<void>) {
  const client = await migratedPGlite();
  try {
    await run(overlapCast(drizzle(client, { schema })));
  } finally {
    await client.close();
  }
}

const audit = {
  id: "audit-1",
  principalId: "principal-c",
  organizationId: "org-1",
  correlationId: "corr-1",
  reason: "removed",
  count: 1,
};

it("keys new secret rows by one keyed lookup and never stores an unkeyed digest", () =>
  withDatabase(async (db) => {
    const token = "pst_new-private-bearer";
    await secretMap<string>(db, TOKENS).set(token, "session-a");
    expect(await storedIds(db, TOKENS)).toEqual([
      oidcLookup(sealer, TOKENS, "id", token),
    ]);
    const dump = JSON.stringify(await db.select().from(schema.oidcPayloads));
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(sha256(token));
    expect(await secretMap(db, TOKENS).legacyRows()).toEqual([]);
  }));

it("computes no unkeyed digest of a key on any request path", () =>
  withDatabase(async (db) => {
    const looked: string[] = [];
    const recording: EventSealer = {
      ...sealer,
      lookupToken: (purpose, value) => {
        looked.push(value);
        return sealer.lookupToken(purpose, value);
      },
    };
    const store = secretMap<string>(db, TOKENS, 60_000, recording);
    await store.set("pst_a", "one");
    await store.claim("pst_b", "two");
    await store.get("pst_a");
    await store.has("pst_missing");
    await store.update("pst_a", () => "three");
    await store.updateMany(["pst_a", "pst_c"], () => "four");
    await store.take("pst_b");
    await store.delete("pst_c");
    expect(looked.length).toBeGreaterThan(0);
    for (const key of ["pst_a", "pst_b", "pst_c", "pst_missing"])
      expect(looked).not.toContain(sha256(key));
  }));

it("refuses a legacy TTL bearer after the upgrade and leaves its row to expire", () =>
  withDatabase(async (db) => {
    const store = secretMap<string>(db, TOKENS, 60_000);
    const token = "pst_before-upgrade";
    await insertLegacy(db, TOKENS, token, "session-l", soon());
    expect(await store.get(token)).toBeUndefined();
    expect(await store.has(token)).toBe(false);
    expect(await store.take(token)).toBeUndefined();
    expect(await store.delete(token)).toBe(false);
    expect(await store.legacyRows()).toEqual([
      {
        id: oidcLookup(sealer, TOKENS, "id", sha256(token)),
        value: "session-l",
      },
    ]);
    // Revoking by session still removes it through its stored entry.
    const [entry] = await store.entries();
    expect(entry?.[1]).toBe("session-l");
    expect(await store.deleteEntry(entry?.[0] ?? "")).toBe(true);
    expect(await storedIds(db, TOKENS)).toEqual([]);
  }));

it("re-keys no-expiry records at startup so a fence is advanced, never reset", () =>
  withDatabase(async (db) => {
    const stores = createAppStores();
    installDurableSecurityMaps(stores, db, 60_000, sealer);
    await db.insert(schema.principals).values({
      id: "principal-c",
      state: "active",
      assurance: "verified",
    });
    await insertLegacy(db, EPOCHS, "principal-c", {
      generation: 3,
      operations: ["pending-revocation"],
    });
    await insertLegacy(db, AUDITS, audit.id, audit);
    const operationKey = `oidc-logout:${"a".repeat(64)}`;
    const operation = {
      operationKey,
      issuer: "https://issuer.example",
      subject: "subject",
      sessionIds: [],
      sessionsRevoked: 0,
      correlationId: "logout",
      retainUntil: Date.now() + 60_000,
      completed: true,
    };
    await insertLegacy(
      db,
      "OpenSesame:UpstreamLogoutOperation",
      operationKey,
      operation,
    );
    await insertLegacy(db, TOKENS, "pst_unrecoverable", "session-t", soon());
    // Before the migration no request can see a legacy row.
    expect(
      await stores.principalSessionEpochs.get("principal-c"),
    ).toBeUndefined();
    expect(await rekeyLegacySecurityRows(stores)).toEqual({
      provisionalProofs: 0,
      provisionalTokens: 1,
      magicLinkExchanges: 0,
      enrollmentTickets: 0,
    });
    expect(await storedIds(db, EPOCHS)).toEqual([
      oidcLookup(sealer, EPOCHS, "id", "principal-c"),
    ]);
    const [row] = await db
      .select()
      .from(schema.oidcPayloads)
      .where(eq(schema.oidcPayloads.model, EPOCHS));
    expect(row?.expiresAt).toBeNull();
    const fences = stores.principalSessionEpochs;
    if (!(fences instanceof DurableMap)) throw new Error("durable epochs");
    expect(
      await fences.update("principal-c", (current) => ({
        generation: (current?.generation ?? 0) + 1,
        operations: [...(current?.operations ?? []), "second"],
      })),
    ).toEqual({ generation: 4, operations: ["pending-revocation", "second"] });
    expect(await stores.organizationRevocationAudits.get(audit.id)).toEqual(
      audit,
    );
    expect(await stores.upstreamLogoutOperations.get(operationKey)).toEqual(
      operation,
    );
    expect(
      await stores.provisionalTokens.get("pst_unrecoverable"),
    ).toBeUndefined();
    // A second start moves nothing and still leaves the bearer to its TTL.
    expect((await rekeyLegacySecurityRows(stores)).provisionalTokens).toBe(1);
  }));

it("keeps a key's current row over its legacy row when both exist", () =>
  withDatabase(async (db) => {
    const fences = secretMap<PrincipalSessionFence>(db, EPOCHS);
    const current = { generation: 5, operations: [] };
    await insertLegacy(db, EPOCHS, "principal-d", {
      generation: 1,
      operations: [],
    });
    await fences.set("principal-d", current);
    expect(await fences.adoptLegacyRow("principal-d")).toBe(true);
    expect(await fences.adoptLegacyRow("principal-d")).toBe(false);
    expect(await storedIds(db, EPOCHS)).toEqual([
      oidcLookup(sealer, EPOCHS, "id", "principal-d"),
    ]);
    expect(await fences.get("principal-d")).toEqual(current);
  }));

it("adopts a live legacy fence over an expired current row instead of dropping it", () =>
  withDatabase(async (db) => {
    const fences = secretMap<PrincipalSessionFence>(db, EPOCHS);
    const fence = { generation: 7, operations: ["revoke-1"] };
    await insertLegacy(db, EPOCHS, "principal-e", fence);
    // A current row that has already expired is not the key's value.
    await db.insert(schema.oidcPayloads).values({
      ...sealOidcRow(sealer, EPOCHS, "principal-e", {
        value: serialize({ generation: 1, operations: [] }).toString("base64"),
        rowId: "keyed-hmac-v2",
      }),
      expiresAt: new Date(Date.now() - 1_000),
    });
    expect(await fences.get("principal-e")).toBeUndefined();
    expect(await fences.adoptLegacyRow("principal-e")).toBe(true);
    expect(await fences.get("principal-e")).toEqual(fence);
    expect(await storedIds(db, EPOCHS)).toEqual([
      oidcLookup(sealer, EPOCHS, "id", "principal-e"),
    ]);
    const [row] = await db
      .select()
      .from(schema.oidcPayloads)
      .where(eq(schema.oidcPayloads.model, EPOCHS));
    expect(row?.expiresAt).toBeNull();
  }));

it("fails startup closed while a no-expiry record cannot be re-keyed", () =>
  withDatabase(async (db) => {
    const stores = createAppStores();
    installDurableSecurityMaps(stores, db, 60_000, sealer);
    // A row whose value names another key is never moved or dropped.
    await insertLegacy(db, AUDITS, "not-the-intent-id", {
      ...audit,
      id: "audit-2",
    });
    const refused = rekeyLegacySecurityRows(stores);
    await expect(refused).rejects.toBeInstanceOf(LegacySecurityRowsRemainError);
    await expect(refused).rejects.toMatchObject({
      remaining: {
        upstreamLogoutOperations: 0,
        organizationRevocationAudits: 1,
        organizationWithdrawalAudits: 0,
        principalSessionEpochs: 0,
      },
    });
    expect(await storedIds(db, AUDITS)).toEqual([
      oidcLookup(sealer, AUDITS, "id", sha256("not-the-intent-id")),
    ]);
  }));

it("serves nothing until migrated, then refuses bearers issued before the upgrade", () =>
  withDatabase(async (db) => {
    const options = {
      database: db,
      config: {
        port: 0,
        publicUrl: "http://localhost",
        issuer: "http://localhost",
        claimPepper,
      },
    };
    const first = createControlPlane(options);
    await first.ctx.securityRecoveryReady;
    const minted = await first.app.request("/v1/principals/provisional", {
      method: "POST",
    });
    expect(minted.status).toBe(201);
    const fresh: {
      principalId: string;
      sessionId: string;
      accessToken: string;
    } = overlapCast(await minted.json());
    const legacyToken = "pst_issued-before-the-upgrade";
    await insertLegacy(db, TOKENS, legacyToken, fresh.sessionId, soon());
    const fence = { generation: 2, operations: [] };
    await insertLegacy(db, EPOCHS, fresh.principalId, fence);

    const restarted = createControlPlane(options);
    await restarted.ctx.securityRecoveryReady;
    expect(
      await restarted.ctx.stores.principalSessionEpochs.get(fresh.principalId),
    ).toEqual(fence);
    const me = (token: string, plane = restarted) =>
      plane.app.request("/v1/principals/me", {
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await me(legacyToken)).status).toBe(401);
    expect((await me(fresh.accessToken)).status).toBe(200);

    await insertLegacy(db, AUDITS, "orphan", { ...audit, id: "audit-3" });
    const refused = createControlPlane(options);
    await expect(refused.ctx.securityRecoveryReady).rejects.toBeInstanceOf(
      LegacySecurityRowsRemainError,
    );
    expect((await me(fresh.accessToken, refused)).status).toBe(503);
    for (const plane of [first, restarted, refused])
      await plane.withdrawalRecovery.stop();
  }));
