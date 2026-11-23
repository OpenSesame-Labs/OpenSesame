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

const SECRET_KEYED_STORES = [
  "provisionalProofs",
  "upstreamLogoutOperations",
  "organizationRevocationAudits",
  "organizationWithdrawalAudits",
  "principalSessionEpochs",
  "provisionalTokens",
  "magicLinkExchanges",
  "enrollmentTickets",
] as const;

/**
 * Move the no-expiry security records written under the legacy row id to the
 * keyed id (durable-map-legacy.ts), then report how many legacy rows remain
 * per store. Every record stays readable throughout: until a row is moved,
 * reads and writes address it under its legacy id as well.
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
  const remaining = await Promise.all(
    SECRET_KEYED_STORES.map(async (name) => {
      const store = stores[name];
      const count =
        store instanceof DurableMap ? (await store.legacyRows()).length : 0;
      return [name, count] as const;
    }),
  );
  return Object.fromEntries(remaining);
}
