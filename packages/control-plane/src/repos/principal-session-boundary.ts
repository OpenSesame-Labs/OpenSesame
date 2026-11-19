import {
  type Database,
  MemoryOrganizationMembershipStore,
  PostgresOrganizationMembershipStore,
  principals,
} from "@opensesame/database";
import { eq, sql } from "drizzle-orm";
import type { AppStores } from "../state.js";
import { DurableMap } from "./durable-map.js";

type MemoryTurn = { tail: Promise<void>; pendingRevocations: number };
const memoryTurns = new WeakMap<object, Map<string, MemoryTurn>>();

export class PrincipalSessionBoundaryChangedError extends Error {
  override readonly name = "PrincipalSessionBoundaryChangedError";
  constructor() {
    super("Principal session authority changed during publication");
  }
}

function lockAcquired(result: unknown): boolean {
  const rows = Array.isArray(result)
    ? result
    : result && typeof result === "object" && "rows" in result
      ? result.rows
      : undefined;
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row || typeof row !== "object" || !("acquired" in row))
    throw new Error("Could not verify the principal session lock");
  return row.acquired === true;
}

async function memoryBoundary<T>(
  stores: AppStores,
  principalId: string,
  mode: "authenticate" | "publish" | "revoke",
  run: (stores: AppStores, database?: Database) => Promise<T>,
): Promise<T> {
  let turns = memoryTurns.get(stores.provisionalSessions);
  if (!turns) {
    turns = new Map();
    memoryTurns.set(stores.provisionalSessions, turns);
  }
  let turn = turns.get(principalId);
  if (!turn) {
    turn = { tail: Promise.resolve(), pendingRevocations: 0 };
    turns.set(principalId, turn);
  }
  if (mode !== "revoke" && turn.pendingRevocations > 0)
    throw new PrincipalSessionBoundaryChangedError();
  if (mode === "revoke") turn.pendingRevocations += 1;
  const previous = turn.tail;
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  turn.tail = tail;
  await previous;
  try {
    return await run(stores);
  } finally {
    release();
    if (mode === "revoke") turn.pendingRevocations -= 1;
    if (turn.tail === tail && turn.pendingRevocations === 0)
      turns.delete(principalId);
  }
}

/**
 * Serialize session publication and membership revocation for one principal.
 * PostgreSQL advisory transaction locks are shared by every API replica and
 * are released automatically if a replica exits.
 */
export async function withPrincipalSessionBoundary<T>(
  stores: AppStores,
  principalId: string,
  mode: "authenticate" | "publish" | "revoke",
  run: (stores: AppStores, database?: Database) => Promise<T>,
): Promise<T> {
  const sessions = stores.provisionalSessions;
  if (!(sessions instanceof DurableMap)) {
    if (
      mode === "revoke" &&
      !(
        stores.organizationMemberships instanceof
        MemoryOrganizationMembershipStore
      )
    ) {
      throw new Error(
        "Session and membership stores must use the same backend",
      );
    }
    return memoryBoundary(stores, principalId, mode, run);
  }
  const tokens = stores.provisionalTokens;
  if (
    !(tokens instanceof DurableMap) ||
    (mode === "revoke" &&
      !(
        stores.organizationMemberships instanceof
        PostgresOrganizationMembershipStore
      ))
  ) {
    throw new Error("Session and membership stores must use the same backend");
  }
  return sessions.transaction(async (db) => {
    if (mode !== "revoke") {
      const result = await db.execute(
        sql`SELECT pg_try_advisory_xact_lock_shared(hashtext('OpenSesame:PrincipalSession'), hashtext(${principalId})) AS acquired`,
      );
      if (!lockAcquired(result))
        throw new PrincipalSessionBoundaryChangedError();
    } else {
      await db.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('OpenSesame:PrincipalSession'), hashtext(${principalId}))`,
      );
    }
    return run(
      {
        ...stores,
        provisionalSessions: sessions.onDatabase(db),
        provisionalTokens: tokens.onDatabase(db),
        organizationMemberships:
          stores.organizationMemberships instanceof
          PostgresOrganizationMembershipStore
            ? new PostgresOrganizationMembershipStore(db)
            : stores.organizationMemberships,
        organizationWithdrawalAudits:
          stores.organizationWithdrawalAudits instanceof DurableMap
            ? stores.organizationWithdrawalAudits.onDatabase(db)
            : stores.organizationWithdrawalAudits,
      },
      db,
    );
  });
}

export async function principalSessionEpochOn(
  db: Database,
  principalId: string,
): Promise<number> {
  const [principal] = await db
    .select({ version: principals.sessionAuthorityVersion })
    .from(principals)
    .where(eq(principals.id, principalId))
    .limit(1);
  return principal?.version ?? 0;
}

export async function principalSessionEpoch(
  stores: AppStores,
  principalId: string,
): Promise<number> {
  if (stores.provisionalSessions instanceof DurableMap) {
    return stores.provisionalSessions.transaction((db) =>
      principalSessionEpochOn(db, principalId),
    );
  }
  return (await stores.principalSessionEpochs.get(principalId)) ?? 0;
}

export async function advancePrincipalSessionEpochOn(
  db: Database,
  principalId: string,
): Promise<number> {
  const [principal] = await db
    .update(principals)
    .set({
      sessionAuthorityVersion: sql`${principals.sessionAuthorityVersion} + 1`,
    })
    .where(eq(principals.id, principalId))
    .returning({ version: principals.sessionAuthorityVersion });
  if (!principal) throw new Error("Principal session authority is missing");
  return principal.version;
}

export async function advancePrincipalSessionEpoch(
  stores: AppStores,
  principalId: string,
): Promise<number> {
  if (stores.provisionalSessions instanceof DurableMap) {
    return stores.provisionalSessions.transaction((db) =>
      advancePrincipalSessionEpochOn(db, principalId),
    );
  }
  const next = (await principalSessionEpoch(stores, principalId)) + 1;
  await stores.principalSessionEpochs.set(principalId, next);
  return next;
}
