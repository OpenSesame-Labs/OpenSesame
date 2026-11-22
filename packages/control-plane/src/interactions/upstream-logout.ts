import {
  AUDIT_CHAIN_GENESIS,
  appendAuditEvent,
  auditEventDigest,
} from "@opensesame/audit";
import type { AuditEvent } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import { deleteSecurityMap, updateSecurityMap } from "../repos/durable-map.js";
import {
  beginProvisionalRevocationBatch,
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
export async function sessionIdsForIdentity(
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
  if (principalIds.size === 0) return [];

  const sessions = [...(await ctx.stores.provisionalSessions.entries())];
  return sessions
    .map(([, session]) => session)
    .filter(
      (session) =>
        principalIds.has(session.principalId) &&
        !session.revokedAt &&
        session.expiresAt > ctx.clock(),
    )
    .map((session) => session.id);
}

export async function revokeProvisionalSessionIds(
  ctx: AppContext,
  sessionIds: readonly string[],
  issuer: string,
): Promise<number> {
  const transitioned = await beginProvisionalRevocationBatch(
    ctx,
    sessionIds.map((sessionId) => ({
      sessionId,
      audit: {
        correlationId: `upstream-logout-${sessionId}`,
        actorType: "system" as const,
        metadata: {
          action: "principal.provisional_revoke",
          issuer,
          via: "upstream_logout",
        },
      },
    })),
  );
  for (const sessionId of sessionIds)
    await finishProvisionalRevocation(ctx, sessionId);
  const revoked = [...transitioned.values()].filter(Boolean).length;
  return revoked;
}

export async function revokeSessionsForIdentity(
  ctx: AppContext,
  issuer: string,
  subject: string,
  tenant?: string,
): Promise<number> {
  return revokeProvisionalSessionIds(
    ctx,
    await sessionIdsForIdentity(ctx, issuer, subject, tenant),
    issuer,
  );
}

async function linkedAudit(
  ctx: AppContext,
  event: AuditEvent,
): Promise<boolean> {
  if (
    !event.previousDigest ||
    !event.digest ||
    event.digest !== auditEventDigest(event, event.previousDigest)
  )
    return false;
  let previous = event.previousDigest;
  const visited = new Set<string>([event.digest]);
  while (previous !== AUDIT_CHAIN_GENESIS) {
    if (visited.has(previous)) return false;
    visited.add(previous);
    const predecessor = await ctx.repos.auditEvents.getByDigest(previous);
    if (
      !predecessor?.previousDigest ||
      predecessor.digest !==
        auditEventDigest(predecessor, predecessor.previousDigest)
    )
      return false;
    previous = predecessor.previousDigest;
  }
  return true;
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
        event.metadata.count === operation.sessionsRevoked &&
        (await linkedAudit(ctx, event)),
    );
  const existing = await ctx.repos.auditEvents.getById(id);
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
        count: operation.sessionsRevoked,
      },
    });
  } catch (error) {
    if (!(await matches(await ctx.repos.auditEvents.getById(id)))) throw error;
  }
}

export async function completeUpstreamLogoutOperation(
  ctx: AppContext,
  operation: UpstreamLogoutOperation,
): Promise<void> {
  await revokeProvisionalSessionIds(
    ctx,
    operation.sessionIds,
    operation.issuer,
  );
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
    ,
    operation,
  ] of await ctx.stores.upstreamLogoutOperations.entries()) {
    if (operation.completed) {
      if (operation.retainUntil <= ctx.clock().getTime())
        await deleteSecurityMap(
          ctx.stores.upstreamLogoutOperations,
          operation.operationKey,
        );
      continue;
    }
    await completeUpstreamLogoutOperation(ctx, operation);
  }
}
