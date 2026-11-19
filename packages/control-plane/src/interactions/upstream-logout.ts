import { appendAuditEvent } from "@opensesame/audit";
import type { AuditEvent } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import {
  deleteSecurityMapEntry,
  updateSecurityMap,
} from "../repos/durable-map.js";
import {
  advancePrincipalSessionEpoch,
  advancePrincipalSessionEpochOn,
  withPrincipalSessionBoundary,
} from "../repos/principal-session-boundary.js";
import {
  beginProvisionalRevocation,
  finishProvisionalRevocation,
} from "../repos/provisional-revocation.js";
import type { UpstreamLogoutOperation } from "../state.js";

const REVOCABLE_IDENTITY_KINDS = [
  "oidc",
  "oauth2",
  "saml",
  "ldap",
  "email",
] as const;

/**
 * Revoke every live provisional session belonging to the principals linked to
 * `(issuer, subject)`; returns how many sessions ended (C17).
 *
 * This is the effect half of OIDC Back-Channel Logout (S10 owns the endpoint
 * that verifies the `logout_token`). It deliberately takes an issuer and a
 * subject rather than a principal id: the caller is holding an upstream
 * assertion, and resolving it to principals here keeps the tuple lookup — the
 * one binding that matters — in one place.
 */
export async function principalIdsForIdentity(
  ctx: AppContext,
  issuer: string,
  subject: string,
  tenant?: string,
): Promise<string[]> {
  const principalIds = new Set<string>();
  for (const kind of REVOCABLE_IDENTITY_KINDS) {
    for (const namespace of tenant ? [undefined, tenant] : [undefined]) {
      const identity = await ctx.repos.externalIdentities.findByTuple({
        kind,
        issuer,
        subject,
        ...(namespace ? { tenant: namespace } : undefined),
      });
      if (identity) principalIds.add(identity.principalId);
    }
  }
  return [...principalIds];
}

export async function revokePrincipalSessions(
  ctx: AppContext,
  principalIds: readonly string[],
  issuer: string,
): Promise<number> {
  const cleanup: Array<{ sessionId: string; newlyRevoked: boolean }> = [];
  for (const principalId of new Set(principalIds)) {
    const revoked = await withPrincipalSessionBoundary(
      ctx.stores,
      principalId,
      "revoke",
      async (stores, database) => {
        if (database)
          await advancePrincipalSessionEpochOn(database, principalId);
        else await advancePrincipalSessionEpoch(stores, principalId);
        const changed: Array<{ sessionId: string; newlyRevoked: boolean }> = [];
        for (const [, session] of await stores.provisionalSessions.entries()) {
          if (
            session.principalId !== principalId ||
            (session.revokedAt && !session.revocationCleanupPending)
          )
            continue;
          const newlyRevoked = !session.revokedAt;
          const txCtx = { ...ctx, stores };
          const began = await beginProvisionalRevocation(txCtx, session.id, {
            actorType: "system",
            correlationId: `upstream-logout-${session.id}`,
            metadata: {
              action: "principal.provisional_revoke",
              issuer,
              via: "upstream_logout",
            },
          });
          if (began) changed.push({ sessionId: session.id, newlyRevoked });
        }
        return changed;
      },
    );
    cleanup.push(...revoked);
  }

  for (const { sessionId } of cleanup)
    await finishProvisionalRevocation(ctx, sessionId);
  return cleanup.filter(({ newlyRevoked }) => newlyRevoked).length;
}

export async function revokeSessionsForIdentity(
  ctx: AppContext,
  issuer: string,
  subject: string,
  tenant?: string,
): Promise<number> {
  return revokePrincipalSessions(
    ctx,
    await principalIdsForIdentity(ctx, issuer, subject, tenant),
    issuer,
  );
}

async function appendUpstreamLogoutAudit(
  ctx: AppContext,
  operation: UpstreamLogoutOperation,
): Promise<void> {
  const digest = operation.operationKey.slice("oidc-logout:".length);
  const id = `upstream-logout:${digest}`;
  const matches = async (event: AuditEvent | null) =>
    Boolean(
      event &&
        event.id === id &&
        event.eventType === "principal.upstream_logout" &&
        event.outcome === "succeeded" &&
        event.correlationId === operation.correlationId &&
        event.actorType === "system" &&
        event.actorId === "upstream" &&
        event.metadata.action === "principal.upstream_logout" &&
        event.metadata.issuer === operation.issuer &&
        event.metadata.via === "backchannel_logout" &&
        event.metadata.count === operation.preparedSessionCount &&
        event.metadata.count_basis === "prepared_session_snapshot",
    );
  const findExisting = async () =>
    (await ctx.repos.auditEvents.list({ limit: 1000 })).find(
      (event) => event.id === id,
    ) ?? null;
  const existing = await findExisting();
  if (existing) {
    if (!(await matches(existing)))
      throw new Error("Conflicting upstream logout audit event");
    return;
  }
  try {
    await appendAuditEvent(ctx.repos.auditEvents, {
      id,
      eventType: "principal.upstream_logout",
      outcome: "succeeded",
      correlationId: operation.correlationId,
      actorType: "system",
      actorId: "upstream",
      metadata: {
        action: "principal.upstream_logout",
        issuer: operation.issuer,
        via: "backchannel_logout",
        count: operation.preparedSessionCount,
        count_basis: "prepared_session_snapshot",
      },
    });
  } catch (error) {
    if (!(await matches(await findExisting()))) throw error;
  }
}

export async function completeUpstreamLogoutOperation(
  ctx: AppContext,
  operation: UpstreamLogoutOperation,
): Promise<void> {
  await revokePrincipalSessions(ctx, operation.principalIds, operation.issuer);
  await appendUpstreamLogoutAudit(ctx, operation);
  await updateSecurityMap(
    ctx.stores.upstreamLogoutOperations,
    operation.operationKey,
    (current) => (current ? { ...current, completed: true } : current),
  );
}

/** Resume verified logout work independently of replaying the original JWT. */
export async function resumePendingUpstreamLogouts(
  ctx: AppContext,
): Promise<void> {
  for (const [
    entryKey,
    operation,
  ] of await ctx.stores.upstreamLogoutOperations.entries()) {
    if (operation.completed) {
      if (operation.retainUntil <= ctx.clock().getTime())
        await deleteSecurityMapEntry(
          ctx.stores.upstreamLogoutOperations,
          entryKey,
        );
      continue;
    }
    await completeUpstreamLogoutOperation(ctx, operation);
  }
}
