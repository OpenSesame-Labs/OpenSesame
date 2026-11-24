import type { Database } from "@opensesame/database";
import { principals } from "@opensesame/database/schema";
import { asc, gt } from "drizzle-orm";
import type { AppStores } from "../state.js";
import { DurableMap } from "./durable-map.js";
import { rekeyKeys, rekeyRecoverable } from "./durable-map-legacy.js";

/** Every principal id, in bounded pages: the keys of principal session epochs. */
async function* principalIds<T>(store: DurableMap<T>): AsyncGenerator<string> {
  let cursor = "";
  for (;;) {
    const page = await store.transaction((db: Database) =>
      db
        .select({ id: principals.id })
        .from(principals)
        .where(gt(principals.id, cursor))
        .orderBy(asc(principals.id))
        .limit(500),
    );
    for (const { id } of page) yield id;
    const last = page.at(-1);
    if (!last || page.length < 500) return;
    cursor = last.id;
  }
}

/** Secret-keyed stores whose records never expire: revocation state. */
const NO_EXPIRY_STORES = [
  "upstreamLogoutOperations",
  "organizationRevocationAudits",
  "organizationWithdrawalAudits",
  "principalSessionEpochs",
] as const;

/** Secret-keyed stores of bearers the server never stored, all TTL-bounded. */
const BEARER_TTL_STORES = [
  "provisionalProofs",
  "provisionalTokens",
  "magicLinkExchanges",
  "enrollmentTickets",
] as const;

type StoreName =
  | (typeof NO_EXPIRY_STORES)[number]
  | (typeof BEARER_TTL_STORES)[number];

/** Legacy rows still present, per named secret-keyed store. */
async function remainingLegacyRows(
  stores: AppStores,
  names: readonly StoreName[],
) {
  const counts = await Promise.all(
    names.map(async (name) => {
      const store = stores[name];
      const count =
        store instanceof DurableMap ? (await store.legacyRows()).length : 0;
      return [name, count] as const;
    }),
  );
  return Object.fromEntries(counts);
}

/** A no-expiry security record could not be moved; startup must not serve. */
export class LegacySecurityRowsRemainError extends Error {
  constructor(readonly remaining: Readonly<Record<string, number>>) {
    super(
      `Legacy security rows could not be re-keyed: ${JSON.stringify(remaining)}`,
    );
    this.name = "LegacySecurityRowsRemainError";
  }
}

/**
 * Move every no-expiry security record written under the legacy row id to the
 * keyed id (durable-map-legacy.ts), before the API serves a request. Requests
 * address only the keyed id, so a revocation, fence or audit left behind would
 * be unfindable: if any remains, this throws and startup fails closed.
 * Returns the legacy bearer rows that remain: they are never migrated, are
 * refused like unknown bearers, and expire with their TTL.
 */
export async function rekeyLegacySecurityRows(stores: AppStores) {
  const {
    upstreamLogoutOperations,
    organizationRevocationAudits,
    organizationWithdrawalAudits,
    principalSessionEpochs,
  } = stores;
  if (upstreamLogoutOperations instanceof DurableMap)
    await rekeyRecoverable(
      upstreamLogoutOperations,
      (operation) => operation.operationKey,
    );
  if (organizationRevocationAudits instanceof DurableMap)
    await rekeyRecoverable(organizationRevocationAudits, (intent) => intent.id);
  if (organizationWithdrawalAudits instanceof DurableMap)
    await rekeyRecoverable(organizationWithdrawalAudits, (intent) => intent.id);
  if (principalSessionEpochs instanceof DurableMap)
    await rekeyKeys(
      principalSessionEpochs,
      principalIds(principalSessionEpochs),
    );
  const unmigrated = await remainingLegacyRows(stores, NO_EXPIRY_STORES);
  if (Object.values(unmigrated).some((count) => count > 0))
    throw new LegacySecurityRowsRemainError(unmigrated);
  return remainingLegacyRows(stores, BEARER_TTL_STORES);
}
