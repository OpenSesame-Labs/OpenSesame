import type { ProvisionalSession } from "@opensesame/os-domain";
import type { AppStores } from "../state.js";
import { DurableMap } from "./durable-map.js";
import { withPrincipalSessionBoundary } from "./principal-session-boundary.js";
import { ProvisionalSessionEpochChangedError } from "./session-errors.js";

export { ProvisionalSessionEpochChangedError } from "./session-errors.js";

async function deleteLogicalToken(
  stores: AppStores,
  key: string,
): Promise<void> {
  const tokens = stores.provisionalTokens;
  if (tokens instanceof DurableMap) await tokens.delete(key);
  else tokens.delete(key);
}

async function deleteStoredTokenEntry(
  stores: AppStores,
  key: string,
): Promise<void> {
  const tokens = stores.provisionalTokens;
  if (tokens instanceof DurableMap) await tokens.deleteEntry(key);
  else tokens.delete(key);
}

export async function saveProvisional(
  stores: AppStores,
  session: ProvisionalSession,
  token: string,
): Promise<void> {
  return withPrincipalSessionBoundary(
    stores,
    session.principalId,
    "publish",
    (bound) => saveProvisionalWithinBoundary(bound, session, token),
  );
}

async function saveProvisionalWithinBoundary(
  stores: AppStores,
  session: ProvisionalSession,
  token: string,
): Promise<void> {
  const fence = (await stores.principalSessionEpochs.get(
    session.principalId,
  )) ?? { generation: 0, operations: [] };
  if (fence.operations.length > 0)
    throw new ProvisionalSessionEpochChangedError();
  await stores.provisionalSessions.set(session.id, session);
  try {
    await stores.provisionalTokens.set(token, session.id);
    const standing = (await stores.principalSessionEpochs.get(
      session.principalId,
    )) ?? { generation: 0, operations: [] };
    if (
      standing.generation !== fence.generation ||
      standing.operations.length > 0
    )
      throw new ProvisionalSessionEpochChangedError();
    if (session.restoreProofHash)
      await stores.provisionalProofs.set(session.id, {
        principalId: session.principalId,
        restoreProofHash: session.restoreProofHash,
      });
  } catch (error) {
    await deleteLogicalToken(stores, token).catch(() => undefined);
    if (stores.provisionalSessions instanceof DurableMap)
      await stores.provisionalSessions
        .delete(session.id)
        .catch(() => undefined);
    else stores.provisionalSessions.delete(session.id);
    throw error;
  }
}

export async function rememberProvisionalProof(
  stores: AppStores,
  session: ProvisionalSession,
): Promise<void> {
  if (!session.restoreProofHash) return;
  await stores.provisionalProofs.set(session.id, {
    principalId: session.principalId,
    restoreProofHash: session.restoreProofHash,
  });
}

export async function removeOrphanTokens(stores: AppStores): Promise<void> {
  for (const [token, id] of await stores.provisionalTokens.entries()) {
    if (!(await stores.provisionalSessions.has(id)))
      await deleteStoredTokenEntry(stores, token);
  }
}

export async function revokeSessionTokens(
  stores: AppStores,
  sessionId: string,
): Promise<void> {
  for (const [token, id] of await stores.provisionalTokens.entries()) {
    if (id === sessionId) await deleteStoredTokenEntry(stores, token);
  }
}
