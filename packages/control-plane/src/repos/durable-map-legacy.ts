import { createHash } from "node:crypto";
import { type EventSealer, oidcLookup } from "@opensesame/database";
import type { JsonObject } from "@opensesame/os-domain";

/**
 * Row-id scheme for secret-keyed durable maps.
 *
 * Every row is stored under one keyed lookup of its logical key,
 * `HMAC-SHA-256(K_lookup, key)`, where `K_lookup` is the HKDF-derived
 * token-lookup key of the deployment's event-sealing secret, and every sealed
 * payload records the scheme (`ROW_ID_SCHEME`). A request addresses a key only
 * by that id: no request path computes an unkeyed digest of a key.
 *
 * Rows written before 2026-11-23 were stored under `HMAC(K_lookup,
 * SHA-256(key))`. This module is the startup migration for them; its legacy
 * id (`legacyPrehashedRowId`, through `DurableMap.legacyIdOf`) is computed
 * only there, from keys the server recovers from its own storage:
 *
 * - No-expiry security records (upstream logout operations, organization
 *   revocation and withdrawal audits, principal session epochs) have keys the
 *   server can recover from storage: an audit or logout row names its own key,
 *   and an epoch is keyed by a principal id from the principals table. Startup
 *   moves each to its keyed id before the API serves a request, and refuses to
 *   start while any such row remains (security-map-rekey.ts).
 * - Bearer-keyed TTL rows (provisional tokens and proofs, magic-link
 *   exchanges, enrollment tickets, passkey challenges, OpenID4VCI codes,
 *   nonces and access tokens) are keyed by a secret the server never stored.
 *   They are not migrated: a bearer issued before the upgrade is refused like
 *   an unknown one, and its row expires with its TTL.
 */
export const ROW_ID_SCHEME = "keyed-hmac-v2";

/** Stored id of a pre-2026-11-23 secret-keyed row; startup migration only. */
export function legacyPrehashedRowId(
  sealer: EventSealer,
  model: string,
  key: string,
): string {
  return oidcLookup(
    sealer,
    model,
    "id",
    createHash("sha256").update(key).digest("hex"),
  );
}

/** Whether an opened payload was written under the current row-id scheme. */
export function hasCurrentRowId(payload: JsonObject): boolean {
  return payload.rowId === ROW_ID_SCHEME;
}

/** A live row still stored under its legacy id, with its record. */
export type LegacyRow<T> = { readonly id: string; readonly value: T };

/** The migration surface of a secret-keyed durable map. */
export interface LegacyRekeyable<T> {
  legacyIdOf(key: string): string | undefined;
  legacyRows(): Promise<LegacyRow<T>[]>;
  adoptLegacyRow(key: string): Promise<boolean>;
}

/**
 * Re-key every live legacy row whose key `recover` names from its own value.
 * A row moves only from the legacy id of the recovered key, so a value that
 * names another key leaves its row in place. Returns the rows that remain.
 */
export async function rekeyRecoverable<T>(
  store: LegacyRekeyable<T>,
  recover: (value: T) => string | undefined,
): Promise<number> {
  let remaining = 0;
  for (const row of await store.legacyRows()) {
    const key = recover(row.value);
    const owned = key !== undefined && store.legacyIdOf(key) === row.id;
    if (!owned || !(await store.adoptLegacyRow(key))) remaining++;
  }
  return remaining;
}

/** Re-key the legacy rows of exactly these candidate keys. Returns rows moved. */
export async function rekeyKeys<T>(
  store: LegacyRekeyable<T>,
  keys: AsyncIterable<string> | Iterable<string>,
): Promise<number> {
  const legacy = new Set((await store.legacyRows()).map((row) => row.id));
  let moved = 0;
  if (legacy.size === 0) return moved;
  for await (const key of keys) {
    const id = store.legacyIdOf(key);
    if (id === undefined || !legacy.has(id)) continue;
    legacy.delete(id);
    if (await store.adoptLegacyRow(key)) moved++;
    if (legacy.size === 0) break;
  }
  return moved;
}
