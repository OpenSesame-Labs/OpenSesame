import { createHash } from "node:crypto";
import { serialize } from "node:v8";
import {
  type Database,
  createEventSealer,
  oidcLookup,
  sealOidcRow,
} from "@opensesame/database";
import * as schema from "@opensesame/database/schema";
import { overlapCast } from "@opensesame/os-domain";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, expect, it, vi } from "vitest";
import { DurableMap } from "../repos/durable-map.js";
import { rekeyLegacySecurityRows } from "../repos/security-map-rekey.js";
import { installDurableSecurityMaps } from "../repos/security-maps.js";
import type { PrincipalSessionFence } from "../security-state-types.js";
import { createAppStores } from "../state.js";
import { migratedPGlite, warmMigratedPGlite } from "./migrated-pglite.js";

vi.setConfig({ testTimeout: 60_000 });
beforeAll(warmMigratedPGlite, 60_000);

const sealer = createEventSealer("durable-security-fixture-key");
const sha256 = (key: string) => createHash("sha256").update(key).digest("hex");

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

function secretMap<T>(db: Database, model: string, ttl: number | null = null) {
  return new DurableMap<T>(db, model, true, ttl, undefined, sealer);
}

async function withDatabase(run: (db: Database) => Promise<void>) {
  const client = await migratedPGlite();
  try {
    await run(overlapCast(drizzle(client, { schema })));
  } finally {
    await client.close();
  }
}

it("keys new secret rows by one keyed lookup and never stores an unkeyed digest", () =>
  withDatabase(async (db) => {
    const model = "OpenSesame:ProvisionalToken";
    const token = "pst_new-private-bearer";
    await secretMap<string>(db, model).set(token, "session-a");
    expect(await storedIds(db, model)).toEqual([
      oidcLookup(sealer, model, "id", token),
    ]);
    const dump = JSON.stringify(await db.select().from(schema.oidcPayloads));
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(sha256(token));
    expect(await secretMap(db, model).legacyRows()).toEqual([]);
  }));

it("reads a legacy no-expiry fence and re-keys it in place, keeping it permanent", () =>
  withDatabase(async (db) => {
    const model = "OpenSesame:PrincipalSessionEpoch";
    const fence = { generation: 7, operations: ["revoke-1"] };
    await insertLegacy(db, model, "principal-a", fence);
    const store = secretMap<PrincipalSessionFence>(db, model);
    expect(await store.legacyRows()).toHaveLength(1);
    expect(await store.get("principal-a")).toEqual(fence);
    expect(await storedIds(db, model)).toEqual([
      oidcLookup(sealer, model, "id", "principal-a"),
    ]);
    const [row] = await db
      .select()
      .from(schema.oidcPayloads)
      .where(eq(schema.oidcPayloads.model, model));
    expect(row?.expiresAt).toBeNull();
    expect(await store.legacyRows()).toEqual([]);
    expect(await store.get("principal-a")).toEqual(fence);
  }));

it("keeps revocation holding across the migration: update, delete, take and claim see legacy rows", () =>
  withDatabase(async (db) => {
    const epochs = "OpenSesame:PrincipalSessionEpoch";
    await insertLegacy(db, epochs, "principal-b", {
      generation: 3,
      operations: ["pending-revocation"],
    });
    const fences = secretMap<PrincipalSessionFence>(db, epochs);
    // A pending revocation fence is advanced, never reset to generation 0.
    const next = await fences.update("principal-b", (current) => ({
      generation: (current?.generation ?? 0) + 1,
      operations: [...(current?.operations ?? []), "second"],
    }));
    expect(next).toEqual({
      generation: 4,
      operations: ["pending-revocation", "second"],
    });
    expect(await storedIds(db, epochs)).toEqual([
      oidcLookup(sealer, epochs, "id", "principal-b"),
    ]);

    const tokens = "OpenSesame:ProvisionalToken";
    const future = new Date(Date.now() + 60_000);
    const store = secretMap<string>(db, tokens, 60_000);
    // A revoked legacy bearer is gone under every id it could occupy.
    await insertLegacy(db, tokens, "pst_revoked", "session-r", future);
    expect(await store.delete("pst_revoked")).toBe(true);
    expect(await store.get("pst_revoked")).toBeUndefined();
    expect(await storedIds(db, tokens)).toEqual([]);
    // A legacy single-use bearer is consumed exactly once.
    await insertLegacy(db, tokens, "pst_once", "session-o", future);
    const taken = await Promise.all([
      store.take("pst_once"),
      store.take("pst_once"),
    ]);
    expect(taken.filter(Boolean)).toEqual(["session-o"]);
    expect(await storedIds(db, tokens)).toEqual([]);
    // A legacy row still occupies its key: claim refuses, set supersedes it.
    await insertLegacy(db, tokens, "pst_held", "session-h", future);
    expect(await store.claim("pst_held", "intruder")).toBe(false);
    expect(await store.get("pst_held")).toBe("session-h");
    await insertLegacy(db, tokens, "pst_replaced", "old", future);
    await store.set("pst_replaced", "new");
    expect(await store.get("pst_replaced")).toBe("new");
    expect(await storedIds(db, tokens)).toEqual(
      [
        oidcLookup(sealer, tokens, "id", "pst_held"),
        oidcLookup(sealer, tokens, "id", "pst_replaced"),
      ].sort(),
    );
  }));

it("re-keys recoverable no-expiry rows at startup and reports only unrecoverable bearers", () =>
  withDatabase(async (db) => {
    const stores = createAppStores();
    installDurableSecurityMaps(stores, db, 60_000, sealer);
    await db.insert(schema.principals).values({
      id: "principal-c",
      state: "active",
      assurance: "verified",
    });
    await insertLegacy(db, "OpenSesame:PrincipalSessionEpoch", "principal-c", {
      generation: 2,
      operations: [],
    });
    const audit = {
      id: "audit-1",
      principalId: "principal-c",
      organizationId: "org-1",
      correlationId: "corr-1",
      reason: "removed",
      count: 1,
    };
    await insertLegacy(
      db,
      "OpenSesame:OrganizationRevocationAudit",
      audit.id,
      audit,
    );
    // A row whose recovered key does not own its id is left where it is.
    await insertLegacy(
      db,
      "OpenSesame:OrganizationRevocationAudit",
      "not-the-intent-id",
      { ...audit, id: "audit-2" },
    );
    const token = "pst_unrecoverable";
    await insertLegacy(
      db,
      "OpenSesame:ProvisionalToken",
      token,
      "session-t",
      new Date(Date.now() + 60_000),
    );
    expect(await rekeyLegacySecurityRows(stores)).toEqual({
      provisionalProofs: 0,
      upstreamLogoutOperations: 0,
      organizationRevocationAudits: 1,
      organizationWithdrawalAudits: 0,
      principalSessionEpochs: 0,
      provisionalTokens: 1,
      magicLinkExchanges: 0,
      enrollmentTickets: 0,
    });
    expect(
      await db
        .select({ id: schema.oidcPayloads.id })
        .from(schema.oidcPayloads)
        .where(
          and(
            eq(schema.oidcPayloads.model, "OpenSesame:PrincipalSessionEpoch"),
            eq(
              schema.oidcPayloads.id,
              oidcLookup(
                sealer,
                "OpenSesame:PrincipalSessionEpoch",
                "id",
                "principal-c",
              ),
            ),
          ),
        ),
    ).toHaveLength(1);
    expect(await stores.organizationRevocationAudits.get(audit.id)).toEqual(
      audit,
    );
    // The unrecoverable bearer stays usable until its TTL ends it.
    expect(await stores.provisionalTokens.get(token)).toBe("session-t");
    expect(await stores.principalSessionEpochs.get("principal-c")).toEqual({
      generation: 2,
      operations: [],
    });
  }));
