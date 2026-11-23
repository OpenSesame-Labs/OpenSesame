import { createHash } from "node:crypto";
import { type EventSealer, oidcLookup } from "@opensesame/database";
import type { JsonObject } from "@opensesame/os-domain";

/**
 * Row-id scheme for secret-keyed durable maps.
 *
 * Current rows (`ROW_ID_SCHEME`): the stored id is one keyed lookup of the
 * logical key, `HMAC-SHA-256(K_lookup, key)`, where `K_lookup` is the
 * HKDF-derived token-lookup key of the deployment's event-sealing secret. No
 * unkeyed digest of the key is ever computed for a new row, and every sealed
 * payload records the scheme so a sweep can tell current rows from legacy ones
 * without knowing any key.
 *
 * Legacy rows (written before 2026-11-23) were keyed by
 * `HMAC(K_lookup, SHA-256(key))`. They stay findable until they are gone:
 * every key-addressed read, write, take and delete also addresses the legacy
 * id, and a row found there is re-keyed to the current id inside the same
 * transaction. Revocation state is never dropped by the migration.
 *
 * Removal plan for `legacyPrehashedRowId` (the only remaining SHA-256 of a
 * key): startup re-keys every legacy row whose key it can recover (audit
 * intents and logout operations carry their key; principal session epochs are
 * keyed by principal id) and logs the per-model count of legacy rows that
 * remain. The rest are bearer-keyed rows with a TTL (provisional tokens and
 * proofs, magic-link exchanges, enrollment tickets, passkey challenges), which
 * are gone once their TTL passes (at most the provisional TTL plus one day).
 * When every deployment reports zero remaining legacy rows, delete this
 * function and the fallback id in `DurableMap`.
 */
export const ROW_ID_SCHEME = "keyed-hmac-v2";

/** Stored id of a pre-2026-11-23 secret-keyed row; migration reads only. */
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
  rekey(key: string): Promise<boolean>;
}

/**
 * Re-key every live legacy row whose key `recover` names from its own value,
 * after checking the row really is that key's. Returns the rows that remain.
 */
export async function rekeyRecoverable<T>(
  store: LegacyRekeyable<T>,
  recover: (value: T) => string | undefined,
): Promise<number> {
  let remaining = 0;
  for (const row of await store.legacyRows()) {
    const key = recover(row.value);
    const owned = key !== undefined && store.legacyIdOf(key) === row.id;
    if (!owned || !(await store.rekey(key))) remaining++;
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
    if (await store.rekey(key)) moved++;
    if (legacy.size === 0) break;
  }
  return moved;
}
