import {
  MemoryOrganizationMembershipStore,
  PostgresOrganizationMembershipStore,
} from "@opensesame/database";
import {
  type BoundaryValue,
  isBoolean,
  isJsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import { sql } from "drizzle-orm";
import type { AppStores } from "../state.js";
import { DurableMap } from "./durable-map.js";
import { ProvisionalSessionEpochChangedError } from "./session-errors.js";

// Memory contexts sharing these stores share the same turn. Durable contexts
// instead use a transaction-scoped lock, released even if a worker crashes.
type MemoryTurn = {
  publishers: number;
  pendingRevocations: number;
  publishersFinished?: Promise<void>;
  releasePublishers?: () => void;
  revocationTail: Promise<void>;
};
const memoryTurns = new WeakMap<object, Map<string, MemoryTurn>>();

async function memoryBoundary<T>(
  stores: AppStores,
  principalId: string,
  mode: "publish" | "revoke",
  run: (stores: AppStores) => Promise<T>,
): Promise<T> {
  let turns = memoryTurns.get(stores.provisionalSessions);
  if (!turns) {
    turns = new Map();
    memoryTurns.set(stores.provisionalSessions, turns);
  }
  let turn = turns.get(principalId);
  if (!turn) {
    turn = {
      publishers: 0,
      pendingRevocations: 0,
      revocationTail: Promise.resolve(),
    };
    turns.set(principalId, turn);
  }
  if (mode === "publish") {
    if (turn.pendingRevocations > 0)
      throw new ProvisionalSessionEpochChangedError();
    if (turn.publishers++ === 0) {
      turn.publishersFinished = new Promise<void>((resolve) => {
        turn.releasePublishers = resolve;
      });
    }
    try {
      return await run(stores);
    } finally {
      if (--turn.publishers === 0) turn.releasePublishers?.();
      if (turn.publishers === 0 && turn.pendingRevocations === 0)
        turns.delete(principalId);
    }
  }
  turn.pendingRevocations += 1;
  const previous = turn.revocationTail;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  turn.revocationTail = previous.then(() => held);
  await previous;
  if (turn.publishers > 0) await turn.publishersFinished;
  try {
    return await run(stores);
  } finally {
    release();
    turn.pendingRevocations -= 1;
    if (turn.publishers === 0 && turn.pendingRevocations === 0)
      turns.delete(principalId);
  }
}

/**
 * Parse the one-row answer of the principal session advisory lock at the
 * database I/O boundary: a bare row list, or a driver result wrapping rows.
 */
function acquired(result: BoundaryValue): boolean {
  const rows = Array.isArray(result)
    ? result
    : isJsonObject(result)
      ? result.rows
      : undefined;
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error("Could not verify the principal session lock");
  }
  const row = rows[0];
  if (row === undefined || !isJsonObject(row)) {
    throw new Error("Could not verify the principal session lock");
  }
  if (!isBoolean(row.acquired)) {
    throw new Error("Invalid principal session lock result");
  }
  return row.acquired;
}

/** Serialize publication with deprovisioning across replicas and crashes. */
export async function withPrincipalSessionBoundary<T>(
  stores: AppStores,
  principalId: string,
  mode: "publish" | "revoke",
  run: (stores: AppStores) => Promise<T>,
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
  const {
    provisionalTokens,
    provisionalProofs,
    principalSessionEpochs,
    organizationRevocationAudits,
    organizationWithdrawalAudits,
  } = stores;
  if (
    !(provisionalTokens instanceof DurableMap) ||
    !(provisionalProofs instanceof DurableMap) ||
    !(principalSessionEpochs instanceof DurableMap) ||
    !(organizationRevocationAudits instanceof DurableMap) ||
    !(organizationWithdrawalAudits instanceof DurableMap) ||
    (mode === "revoke" &&
      !(
        stores.organizationMemberships instanceof
        PostgresOrganizationMembershipStore
      ))
  ) {
    throw new Error("Session and membership stores must use the same backend");
  }
  return sessions.transaction(async (db) => {
    if (mode === "publish") {
      const result: BoundaryValue = overlapCast(
        await db.execute(
          sql`SELECT pg_try_advisory_xact_lock_shared(hashtext('OpenSesame:PrincipalSession'), hashtext(${principalId})) AS acquired`,
        ),
      );
      if (!acquired(result)) throw new ProvisionalSessionEpochChangedError();
    } else {
      await db.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('OpenSesame:PrincipalSession'), hashtext(${principalId}))`,
      );
    }
    return run({
      ...stores,
      provisionalSessions: sessions.onDatabase(db),
      provisionalTokens: provisionalTokens.onDatabase(db),
      provisionalProofs: provisionalProofs.onDatabase(db),
      principalSessionEpochs: principalSessionEpochs.onDatabase(db),
      organizationRevocationAudits: organizationRevocationAudits.onDatabase(db),
      organizationWithdrawalAudits: organizationWithdrawalAudits.onDatabase(db),
      organizationMemberships:
        stores.organizationMemberships instanceof
        PostgresOrganizationMembershipStore
          ? new PostgresOrganizationMembershipStore(db)
          : stores.organizationMemberships,
    });
  });
}
