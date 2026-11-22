import {
  AUDIT_CHAIN_GENESIS,
  appendAuditEvent,
  auditEventDigest,
  redactAuditMetadata,
} from "@opensesame/audit";
import { scrubText } from "@opensesame/log-scrub";
import type { AuditEvent } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";

/** Written atomically with membership removal and the session transitions. */
export type OrganizationRevocationAuditIntent = {
  id: string;
  principalId: string;
  organizationId: string;
  correlationId: string;
  reason: string;
  count: number;
};

function validate(intent: OrganizationRevocationAuditIntent): void {
  if (
    !intent ||
    typeof intent.id !== "string" ||
    !intent.id ||
    typeof intent.principalId !== "string" ||
    !intent.principalId ||
    typeof intent.organizationId !== "string" ||
    !intent.organizationId ||
    typeof intent.correlationId !== "string" ||
    !intent.correlationId ||
    typeof intent.reason !== "string" ||
    !Number.isSafeInteger(intent.count) ||
    intent.count < 0
  )
    throw new Error("Invalid organization revocation audit intent");
}

function matchesAudit(
  event: AuditEvent,
  intent: OrganizationRevocationAuditIntent,
): boolean {
  return (
    event.eventType === "organization.member_revoked" &&
    event.outcome === "succeeded" &&
    event.actorType === "system" &&
    event.principalId === scrubText(intent.principalId) &&
    event.organizationId === intent.organizationId &&
    event.correlationId === intent.correlationId &&
    event.metadata.action === "organization.member.revoke" &&
    event.metadata.reason ===
      redactAuditMetadata({ reason: intent.reason }).reason &&
    event.metadata.count === intent.count
  );
}

async function linkedAudit(
  ctx: AppContext,
  intent: OrganizationRevocationAuditIntent,
): Promise<boolean> {
  const event = await ctx.repos.auditEvents.getById(
    `organization-revoke:${intent.id}`,
  );
  if (
    !event ||
    !matchesAudit(event, intent) ||
    !event.previousDigest ||
    event.digest !== auditEventDigest(event, event.previousDigest)
  )
    return false;
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

/** Idempotently link the audit event before discarding the durable intent. */
export async function finishOrganizationRevocationAudit(
  ctx: AppContext,
  intent: OrganizationRevocationAuditIntent,
): Promise<void> {
  validate(intent);
  const id = `organization-revoke:${intent.id}`;
  const existing = await ctx.repos.auditEvents.getById(id);
  if (!existing) {
    try {
      await appendAuditEvent(ctx.repos.auditEvents, {
        id,
        eventType: "organization.member_revoked",
        outcome: "succeeded",
        actorType: "system",
        principalId: intent.principalId,
        organizationId: intent.organizationId,
        correlationId: intent.correlationId,
        metadata: {
          action: "organization.member.revoke",
          reason: intent.reason,
          count: intent.count,
        },
      });
    } catch (error) {
      if (!(await linkedAudit(ctx, intent))) throw error;
    }
  }
  if (!(await linkedAudit(ctx, intent)))
    throw new Error("Conflicting organization revocation audit event");
  await ctx.stores.organizationRevocationAudits.delete(intent.id);
}

/** Startup recovery finishes intents left by a terminated replica. */
export async function resumePendingOrganizationRevocationAudits(
  ctx: AppContext,
): Promise<void> {
  for (const intent of await ctx.stores.organizationRevocationAudits.values()) {
    await finishOrganizationRevocationAudit(ctx, intent);
  }
}
