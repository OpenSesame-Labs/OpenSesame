import { createHash } from "node:crypto";
import {
  AUDIT_CHAIN_GENESIS,
  appendAuditEvent,
  auditEventDigest,
} from "@opensesame/audit";
import { scrubText } from "@opensesame/log-scrub";
import type {
  AuditActorType,
  JsonObject,
  ProvisionalSession,
} from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import { updateSecurityMap, updateSecurityMapMany } from "./durable-map.js";
import { revokeSessionTokens } from "./session-storage.js";

export type ProvisionalRevocationAudit = Readonly<{
  actorType: AuditActorType;
  correlationId: string;
  metadata?: JsonObject;
}>;

const eventId = (sessionId: string) =>
  `provisional-revoke:${createHash("sha256").update(sessionId).digest("hex")}`;

function matchesAudit(
  event: Awaited<ReturnType<AppContext["repos"]["auditEvents"]["getById"]>>,
  session: ProvisionalSession,
): boolean {
  const cleanup = session.revocationCleanup;
  return (
    event?.eventType === "principal.provisional_revoked" &&
    event.outcome === "succeeded" &&
    event.principalId === scrubText(session.principalId) &&
    event.sessionId === scrubText(session.id) &&
    event.metadata.action === "principal.provisional_revoke" &&
    Boolean(
      event.previousDigest &&
        event.digest === auditEventDigest(event, event.previousDigest),
    ) &&
    (!cleanup ||
      (event.actorType === cleanup.actorType &&
        event.correlationId === cleanup.correlationId))
  );
}

async function linkedAudit(
  ctx: AppContext,
  session: ProvisionalSession,
): Promise<boolean> {
  const event = await ctx.repos.auditEvents.getById(eventId(session.id));
  if (!matchesAudit(event, session) || !event?.previousDigest) return false;
  let previous = event.previousDigest;
  const visited = new Set<string>([event.digest ?? ""]);
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

async function appendRevocationAudit(
  ctx: AppContext,
  session: ProvisionalSession,
): Promise<void> {
  const id = eventId(session.id);
  const existing = await ctx.repos.auditEvents.getById(id);
  if (existing) {
    if (!(await linkedAudit(ctx, session)))
      throw new Error("Conflicting provisional revocation audit event");
    return;
  }
  const cleanup = session.revocationCleanup ?? {
    actorType: "system" as const,
    correlationId: id,
    metadata: { action: "principal.provisional_revoke" },
  };
  try {
    await appendAuditEvent(ctx.repos.auditEvents, {
      id,
      eventType: "principal.provisional_revoked",
      outcome: "succeeded",
      principalId: session.principalId,
      sessionId: session.id,
      correlationId: cleanup.correlationId,
      actorType: cleanup.actorType,
      metadata: {
        ...cleanup.metadata,
        action: "principal.provisional_revoke",
      },
    });
  } catch (error) {
    if (!(await linkedAudit(ctx, session))) throw error;
  }
}

export async function beginProvisionalRevocation(
  ctx: AppContext,
  sessionId: string,
  audit: ProvisionalRevocationAudit,
  accept: (session: ProvisionalSession) => boolean = () => true,
  transition?: (newlyRevoked: boolean) => void,
): Promise<ProvisionalSession | undefined> {
  let result: ProvisionalSession | undefined;
  await updateSecurityMap(
    ctx.stores.provisionalSessions,
    sessionId,
    (session) => {
      if (!session || !accept(session)) return session;
      transition?.(!session.revokedAt);
      const cleanup = session.revocationCleanup ?? {
        actorType: audit.actorType,
        correlationId: audit.correlationId,
        metadata: {
          ...audit.metadata,
          action: "principal.provisional_revoke",
        },
      };
      result = {
        ...session,
        revokedAt: session.revokedAt ?? ctx.clock(),
        revocationCleanupPending: true,
        revocationCleanup: cleanup,
      };
      return result;
    },
  );
  return result;
}

/** Mark an entire revocation set in one durable transaction before cleanup. */
export async function beginProvisionalRevocationBatch(
  ctx: AppContext,
  candidates: readonly Readonly<{
    sessionId: string;
    audit: ProvisionalRevocationAudit;
  }>[],
): Promise<ReadonlyMap<string, boolean>> {
  const audits = new Map(
    candidates.map((candidate) => [candidate.sessionId, candidate.audit]),
  );
  const transitioned = new Map<string, boolean>();
  await updateSecurityMapMany(
    ctx.stores.provisionalSessions,
    [...audits.keys()],
    (sessionId, session) => {
      const audit = audits.get(sessionId);
      if (!session || !audit) return session;
      // finishProvisionalRevocation only clears the pending marker after the
      // bearer is removed and its attributed audit event is durably linked.
      // Recheck that state inside this atomic update so a completed human
      // revocation cannot be reopened by a concurrent system batch.
      if (session.revokedAt && !session.revocationCleanupPending) {
        transitioned.set(sessionId, false);
        return session;
      }
      transitioned.set(sessionId, !session.revokedAt);
      return {
        ...session,
        revokedAt: session.revokedAt ?? ctx.clock(),
        revocationCleanupPending: true,
        revocationCleanup: session.revocationCleanup ?? {
          actorType: audit.actorType,
          correlationId: audit.correlationId,
          metadata: {
            ...audit.metadata,
            action: "principal.provisional_revoke",
          },
        },
      };
    },
  );
  return transitioned;
}

export async function finishProvisionalRevocation(
  ctx: AppContext,
  sessionId: string,
): Promise<boolean> {
  const session = await ctx.stores.provisionalSessions.get(sessionId);
  if (!session?.revokedAt) return false;
  await revokeSessionTokens(ctx.stores, sessionId);
  await appendRevocationAudit(ctx, session);
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
  return true;
}

export async function revokeProvisionalSession(
  ctx: AppContext,
  sessionId: string,
  audit: ProvisionalRevocationAudit,
): Promise<ProvisionalSession | undefined> {
  const session = await beginProvisionalRevocation(ctx, sessionId, audit);
  if (session) await finishProvisionalRevocation(ctx, sessionId);
  return session;
}

/** Revoke and report whether this atomic transition was the one that ended it. */
export async function revokeProvisionalSessionTransition(
  ctx: AppContext,
  sessionId: string,
  audit: ProvisionalRevocationAudit,
): Promise<
  Readonly<{ session: ProvisionalSession; newlyRevoked: boolean }> | undefined
> {
  let newlyRevoked = false;
  const session = await beginProvisionalRevocation(
    ctx,
    sessionId,
    audit,
    () => true,
    (transitioned) => {
      newlyRevoked = transitioned;
    },
  );
  if (!session) return undefined;
  await finishProvisionalRevocation(ctx, sessionId);
  return { session, newlyRevoked };
}

/** Retry durable work without requiring the browser proof that initiated it. */
export async function resumePendingProvisionalRevocations(
  ctx: AppContext,
): Promise<void> {
  for (const [, session] of await ctx.stores.provisionalSessions.entries()) {
    if (!session.revocationCleanupPending) continue;
    if (!session.revokedAt)
      throw new Error(
        "Pending provisional revocation lacks a revocation timestamp",
      );
    await finishProvisionalRevocation(ctx, session.id);
  }
}

export async function provisionalRevocationComplete(
  ctx: AppContext,
  session: ProvisionalSession,
): Promise<boolean> {
  return linkedAudit(ctx, session);
}
