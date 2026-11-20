import { createHash } from "node:crypto";
import {
  AUDIT_CHAIN_GENESIS,
  appendAuditEvent,
  auditEventDigest,
  redactAuditMetadata,
} from "@opensesame/audit";
import type {
  AuditActorType,
  JsonObject,
  ProvisionalSession,
} from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import { updateSecurityMap } from "./durable-map.js";
import { revokeSessionTokens } from "./session-storage.js";

export type ProvisionalRevocationAudit = Readonly<{
  actorType: AuditActorType;
  correlationId: string;
  metadata: JsonObject;
}>;

const eventId = (sessionId: string) =>
  `provisional-revoke:${createHash("sha256").update(sessionId).digest("hex")}`;

async function linkedAudit(
  ctx: AppContext,
  session: ProvisionalSession,
): Promise<boolean> {
  const event = await ctx.repos.auditEvents.getById(eventId(session.id));
  const cleanup = session.revocationCleanup;
  const metadata = redactAuditMetadata({
    ...(cleanup?.metadata ?? {}),
    action: "principal.provisional_revoke",
  });
  if (
    !event?.previousDigest ||
    !event.digest ||
    event.eventType !== "principal.provisional_revoked" ||
    event.outcome !== "succeeded" ||
    event.sessionId !== session.id ||
    event.principalId !== session.principalId ||
    (cleanup &&
      (event.actorType !== cleanup.actorType ||
        event.correlationId !== cleanup.correlationId)) ||
    Object.entries(metadata).some(
      ([key, value]) => event.metadata[key] !== value,
    ) ||
    event.digest !== auditEventDigest(event, event.previousDigest)
  )
    return false;
  let previous = event.previousDigest;
  const visited = new Set<string>([event.digest]);
  while (previous !== AUDIT_CHAIN_GENESIS) {
    if (visited.has(previous)) return false;
    visited.add(previous);
    const predecessor = await ctx.repos.auditEvents.findByDigest(previous);
    if (
      !predecessor?.previousDigest ||
      !predecessor.digest ||
      predecessor.digest !==
        auditEventDigest(predecessor, predecessor.previousDigest)
    )
      return false;
    previous = predecessor.previousDigest;
  }
  return true;
}

export async function finishProvisionalRevocation(
  ctx: AppContext,
  sessionId: string,
): Promise<void> {
  const session = await ctx.stores.provisionalSessions.get(sessionId);
  if (!session?.revokedAt || !session.revocationCleanupPending) return;
  await revokeSessionTokens(ctx.stores, sessionId);
  const audit = session.revocationCleanup ?? {
    actorType: "system" as const,
    correlationId: eventId(sessionId),
    metadata: {},
  };
  if (!(await ctx.repos.auditEvents.getById(eventId(sessionId)))) {
    try {
      await appendAuditEvent(ctx.repos.auditEvents, {
        id: eventId(sessionId),
        eventType: "principal.provisional_revoked",
        outcome: "succeeded",
        principalId: session.principalId,
        sessionId,
        actorType: audit.actorType,
        correlationId: audit.correlationId,
        metadata: {
          ...audit.metadata,
          action: "principal.provisional_revoke",
        },
      });
    } catch (error) {
      if (!(await linkedAudit(ctx, session))) throw error;
    }
  }
  if (!(await linkedAudit(ctx, session)))
    throw new Error("Conflicting provisional revocation audit event");
  await updateSecurityMap(
    ctx.stores.provisionalSessions,
    sessionId,
    (current) => {
      if (!current?.revokedAt || current.principalId !== session.principalId)
        return current;
      const {
        revocationCleanup: _cleanup,
        revocationCleanupPending: _pending,
        ...complete
      } = current;
      return complete;
    },
  );
}

export async function revokeProvisionalSession(
  ctx: AppContext,
  sessionId: string,
  audit: ProvisionalRevocationAudit,
): Promise<void> {
  await beginProvisionalRevocation(ctx, sessionId, audit);
  await finishProvisionalRevocation(ctx, sessionId);
}

export async function beginProvisionalRevocation(
  ctx: AppContext,
  sessionId: string,
  audit: ProvisionalRevocationAudit,
): Promise<boolean> {
  let found = false;
  await updateSecurityMap(
    ctx.stores.provisionalSessions,
    sessionId,
    (session) => {
      if (!session) return session;
      found = true;
      return {
        ...session,
        revokedAt: session.revokedAt ?? ctx.clock(),
        revocationCleanupPending: true,
        revocationCleanup: session.revocationCleanup ?? audit,
      };
    },
  );
  return found;
}

export async function resumePendingProvisionalRevocations(
  ctx: AppContext,
): Promise<void> {
  for (const [, session] of await ctx.stores.provisionalSessions.entries()) {
    if (session.revocationCleanupPending)
      await finishProvisionalRevocation(ctx, session.id);
  }
}
