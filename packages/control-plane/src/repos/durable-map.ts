import {
  type Database,
  type EventSealer,
  oidcLookup,
  oidcPayloads,
  openOidcRow,
  sealOidcRow,
} from "@opensesame/database";
import { overlapCast } from "@opensesame/os-domain";
import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import {
  type LegacyRow,
  hasCurrentRowId,
  legacyPrehashedRowId,
} from "./durable-map-legacy.js";
import { decodeRecord, encodeRecord, recordExpiry } from "./durable-record.js";

/** Internal server-owned records only; never deserialize client-supplied bytes. */
export class DurableMap<T> {
  private readonly sealer: EventSealer;
  constructor(
    private readonly db: Database,
    private readonly model: string,
    private readonly secretKeys = false,
    private readonly ttlMs: number | null = 86_400_000,
    private readonly capacity = 10_000,
    sealer?: EventSealer,
  ) {
    if (!sealer)
      throw new Error("A durable sealing key is required for security state");
    this.sealer = sealer;
    if (!model.startsWith("OpenSesame:"))
      throw new Error("Invalid internal state namespace");
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10_000)
      throw new Error("Invalid security store capacity");
  }

  /** Bind the same protected namespace to an existing database transaction. */
  onDatabase(db: Database): DurableMap<T> {
    return this.bound(db);
  }

  /** Begin a transaction on the pool that owns this namespace. */
  transaction<TValue>(run: (db: Database) => Promise<TValue>): Promise<TValue> {
    return this.db.transaction((tx) => run(overlapCast(tx)));
  }

  /**
   * The only stored id a key occupies: one keyed lookup of the key (see
   * durable-map-legacy.ts). Every key-addressed operation uses this id alone.
   */
  private id(key: string) {
    return oidcLookup(this.sealer, this.model, "id", key);
  }
  private condition(key: string) {
    return this.storedRow(this.id(key));
  }
  private storedRow(id: string) {
    return and(eq(oidcPayloads.model, this.model), eq(oidcPayloads.id, id));
  }
  private live() {
    return or(
      isNull(oidcPayloads.expiresAt),
      gt(oidcPayloads.expiresAt, new Date()),
    );
  }
  private lock(tx: Database) {
    return tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('OpenSesame:Capacity'), hashtext(${this.model}))`,
    );
  }
  async get(key: string): Promise<T | undefined> {
    const [row] = await this.db
      .select()
      .from(oidcPayloads)
      .where(and(this.condition(key), this.live()))
      .limit(1);
    return row ? decodeRecord<T>(openOidcRow(this.sealer, row)) : undefined;
  }
  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== undefined;
  }
  /**
   * Startup migration only: the legacy stored id `key` would occupy. No
   * request path calls this; a request addresses only the keyed id.
   */
  legacyIdOf(key: string): string | undefined {
    return this.secretKeys
      ? legacyPrehashedRowId(this.sealer, this.model, key)
      : undefined;
  }
  /**
   * Startup migration only: move `key`'s legacy row to its keyed id in one
   * locked transaction. A live current row for the key wins and the legacy
   * row is removed; otherwise the successor is written (replacing an expired
   * current row) with the legacy row's expiry before the legacy row is
   * deleted, so a fence or revocation it holds is never absent. False when
   * `key` has no legacy row.
   */
  async adoptLegacyRow(key: string): Promise<boolean> {
    const legacyId = this.legacyIdOf(key);
    if (legacyId === undefined) return false;
    return this.db.transaction(async (tx) => {
      await this.lock(overlapCast(tx));
      const [legacy] = await tx
        .select()
        .from(oidcPayloads)
        .where(this.storedRow(legacyId));
      if (!legacy) return false;
      const payload = openOidcRow(this.sealer, legacy);
      if (hasCurrentRowId(payload)) return false;
      // An expired current row is not the key's value; the live legacy row is.
      const [current] = await tx
        .select({ id: oidcPayloads.id })
        .from(oidcPayloads)
        .where(and(this.condition(key), this.live()));
      if (!current) {
        const record = encodeRecord(this.model, key, decodeRecord<T>(payload));
        const sealed = sealOidcRow(this.sealer, this.model, key, record);
        await this.upsert(overlapCast(tx), sealed, legacy.expiresAt);
      }
      await tx.delete(oidcPayloads).where(this.storedRow(legacyId));
      return true;
    });
  }
  /** Live rows still stored under a legacy id, with their values. */
  async legacyRows(): Promise<LegacyRow<T>[]> {
    if (!this.secretKeys) return [];
    const legacy: LegacyRow<T>[] = [];
    for (const row of await this.rows()) {
      const payload = openOidcRow(this.sealer, row);
      if (!hasCurrentRowId(payload))
        legacy.push({ id: row.id, value: decodeRecord<T>(payload) });
    }
    return legacy;
  }
  private async write(
    key: string,
    value: T,
    onlyIfAbsent: boolean,
  ): Promise<boolean> {
    const sealed = sealOidcRow(
      this.sealer,
      this.model,
      key,
      encodeRecord(this.model, key, value),
    );
    return this.db.transaction(async (tx) => {
      await this.lock(overlapCast(tx));
      await tx
        .delete(oidcPayloads)
        .where(
          and(
            eq(oidcPayloads.model, this.model),
            lte(oidcPayloads.expiresAt, new Date()),
          ),
        );
      const [existing] = await tx
        .select({ id: oidcPayloads.id })
        .from(oidcPayloads)
        .where(this.condition(key));
      if (existing && onlyIfAbsent) return false;
      if (!existing) {
        const [size] = await tx
          .select({ count: sql<number>`count(*)::integer` })
          .from(oidcPayloads)
          .where(eq(oidcPayloads.model, this.model));
        if ((size?.count ?? this.capacity) >= this.capacity)
          throw new Error("Security store capacity exceeded");
      }
      const expiresAt = recordExpiry(this.model, this.ttlMs, value);
      await this.upsert(overlapCast(tx), sealed, expiresAt);
      return true;
    });
  }
  /** Insert a sealed row, replacing the row already stored under its id. */
  private async upsert(
    tx: Database,
    sealed: ReturnType<typeof sealOidcRow>,
    expiresAt: Date | null,
  ) {
    await tx
      .insert(oidcPayloads)
      .values({ ...sealed, expiresAt })
      .onConflictDoUpdate({
        target: [oidcPayloads.model, oidcPayloads.id],
        set: {
          payload: sealed.payload,
          sealScope: sealed.sealScope,
          uid: sealed.uid,
          userCode: sealed.userCode,
          grantId: sealed.grantId,
          expiresAt,
        },
      });
  }
  async set(key: string, value: T): Promise<this> {
    await this.write(key, value, false);
    return this;
  }
  async claim(key: string, value: T): Promise<boolean> {
    return this.write(key, value, true);
  }
  /** Removes the key's row. */
  async delete(key: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await this.lock(overlapCast(tx));
      const rows = await tx
        .delete(oidcPayloads)
        .where(this.condition(key))
        .returning({ id: oidcPayloads.id });
      return rows.length > 0;
    });
  }
  /** Only keys obtained by entries(); ordinary credential keys always use delete(). */
  async deleteEntry(storedKey: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await this.lock(overlapCast(tx));
      const rows = await tx
        .delete(oidcPayloads)
        .where(this.storedRow(storedKey))
        .returning({ id: oidcPayloads.id });
      return rows.length === 1;
    });
  }
  /** Atomic single-use consumption, shared by every replica. */
  async take(key: string): Promise<T | undefined> {
    return this.db.transaction(async (tx) => {
      await this.lock(overlapCast(tx));
      const [row] = await tx
        .delete(oidcPayloads)
        .where(and(this.condition(key), this.live()))
        .returning();
      return row ? decodeRecord<T>(openOidcRow(this.sealer, row)) : undefined;
    });
  }
  get size(): Promise<number> {
    return this.db
      .select({ count: sql<number>`count(*)::integer` })
      .from(oidcPayloads)
      .where(and(eq(oidcPayloads.model, this.model), this.live()))
      .then((rows) => rows[0]?.count ?? 0);
  }
  private async rows() {
    const rows = await this.db
      .select()
      .from(oidcPayloads)
      .where(and(eq(oidcPayloads.model, this.model), this.live()))
      .limit(10_001);
    if (rows.length > 10_000)
      throw new Error("Security store capacity exceeded");
    return rows;
  }
  async entries(): Promise<[string, T][]> {
    return (await this.rows()).map((row) => [
      row.id,
      decodeRecord<T>(openOidcRow(this.sealer, row)),
    ]);
  }
  async values(): Promise<T[]> {
    return (await this.entries()).map(([, value]) => value);
  }
  private bound(tx: Database): DurableMap<T> {
    return new DurableMap<T>(
      tx,
      this.model,
      this.secretKeys,
      this.ttlMs,
      this.capacity,
      this.sealer,
    );
  }
  async update(
    key: string,
    change: (current: T | undefined) => T | undefined,
  ): Promise<T | undefined> {
    return this.db.transaction(async (tx) => {
      await this.lock(overlapCast(tx));
      const store = this.bound(overlapCast(tx));
      const next = change(await store.get(key));
      if (next === undefined) await store.delete(key);
      else await store.set(key, next);
      return next;
    });
  }

  /** Atomically update several logical keys under one replica-shared transaction. */
  async updateMany(
    keys: readonly string[],
    change: (key: string, current: T | undefined) => T | undefined,
  ): Promise<Map<string, T | undefined>> {
    return this.db.transaction(async (tx) => {
      await this.lock(overlapCast(tx));
      const store = this.bound(overlapCast(tx));
      const result = new Map<string, T | undefined>();
      for (const key of [...new Set(keys)]) {
        const next = change(key, await store.get(key));
        if (next === undefined) await store.delete(key);
        else await store.set(key, next);
        result.set(key, next);
      }
      return result;
    });
  }
}

export type SecurityMap<T> = Map<string, T> | DurableMap<T>;

export async function updateSecurityMap<T>(
  store: SecurityMap<T>,
  key: string,
  change: (current: T | undefined) => T | undefined,
): Promise<T | undefined> {
  if (store instanceof DurableMap) return store.update(key, change);
  const next = change(store.get(key));
  if (next === undefined) store.delete(key);
  else store.set(key, next);
  return next;
}

export async function updateSecurityMapMany<T>(
  store: SecurityMap<T>,
  keys: readonly string[],
  change: (key: string, current: T | undefined) => T | undefined,
): Promise<Map<string, T | undefined>> {
  if (store instanceof DurableMap) return store.updateMany(keys, change);
  const result = new Map<string, T | undefined>();
  for (const key of [...new Set(keys)]) {
    const next = change(key, store.get(key));
    if (next === undefined) store.delete(key);
    else store.set(key, next);
    result.set(key, next);
  }
  return result;
}

export async function deleteSecurityMap<T>(
  store: SecurityMap<T>,
  key: string,
): Promise<void> {
  if (store instanceof DurableMap) await store.delete(key);
  else store.delete(key);
}

export async function takeSecurityMap<T>(
  store: SecurityMap<T>,
  key: string,
): Promise<T | undefined> {
  if (store instanceof DurableMap) return store.take(key);
  const current = store.get(key);
  store.delete(key);
  return current;
}

export async function incrementSecurityCounter(
  store: SecurityMap<number>,
  key: string,
): Promise<number> {
  const count = await updateSecurityMap(store, key, (current) =>
    Math.min((current ?? 0) + 1, 1_000_000),
  );
  if (count === undefined) throw new Error("Security counter unavailable");
  return count;
}

export async function deleteSecurityMapEntry<T>(
  store: SecurityMap<T>,
  key: string,
): Promise<boolean> {
  return store instanceof DurableMap
    ? store.deleteEntry(key)
    : store.delete(key);
}
