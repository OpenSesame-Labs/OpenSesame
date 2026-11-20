import {
  AUDIT_CHAIN_GENESIS,
  appendAuditEvent,
  auditEventDigest,
  redactAuditMetadata,
} from "@opensesame/audit";
import { scrubText } from "@opensesame/log-scrub";
import {
  type BoundaryValue,
  type JsonObject,
  type OrganizationRole,
  isString,
} from "@opensesame/os-domain";
import type { AppContext } from "../context.js";

/** Written in the transaction that completes the membership transition. */
export type OrganizationWithdrawalAuditIntent = {
  id: string;
  actorPrincipalId: string;
  actorType: "human" | "system";
  organizationId: string;
  principalId: string;
  correlationId: string;
  previousRole: OrganizationRole;
} & ({ kind: "remove" } | { kind: "change_role"; role: OrganizationRole });

function validRole(role: BoundaryValue): role is OrganizationRole {
  return role === "owner" || role === "admin" || role === "member";
}

function validate(intent: OrganizationWithdrawalAuditIntent): void {
  if (
    !intent ||
    ![
      intent.id,
      intent.actorPrincipalId,
      intent.organizationId,
      intent.principalId,
      intent.correlationId,
    ].every((value) => isString(value) && value.length > 0) ||
    (intent.actorType !== "human" && intent.actorType !== "system") ||
    !validRole(intent.previousRole) ||
    (intent.kind !== "remove" && intent.kind !== "change_role") ||
    (intent.kind === "change_role" && !validRole(intent.role))
  )
    throw new Error("Invalid organization withdrawal audit intent");
}

function eventInput(intent: OrganizationWithdrawalAuditIntent) {
  const metadata: JsonObject = {
    action:
      intent.kind === "remove"
        ? "organization.member.remove"
        : "organization.member.role.change",
    targetId: intent.principalId,
    fromState: intent.previousRole,
  };
  if (intent.kind === "change_role") metadata.toState = intent.role;
  const input = {
    id: `organization-withdrawal:${intent.id}`,
    eventType:
      intent.kind === "remove"
        ? "organization.member_removed"
        : "organization.member_role_changed",
    outcome: "succeeded" as const,
    actorType: intent.actorType,
    principalId: intent.actorPrincipalId,
    organizationId: intent.organizationId,
    correlationId: intent.correlationId,
    metadata,
  };
  return input;
}

async function belongsToAuditChain(
  ctx: AppContext,
  event: NonNullable<
    Awaited<ReturnType<AppContext["repos"]["auditEvents"]["getById"]>>
  >,
): Promise<boolean> {
  const visited = new Set<string>();
  let cursor = event;
  while (cursor.previousDigest !== AUDIT_CHAIN_GENESIS) {
    if (
      !cursor.previousDigest ||
      !cursor.digest ||
      cursor.digest !== auditEventDigest(cursor, cursor.previousDigest) ||
      visited.has(cursor.digest)
    )
      return false;
    visited.add(cursor.digest);
    const predecessor = await ctx.repos.auditEvents.findByDigest(
      cursor.previousDigest,
    );
    if (!predecessor) return false;
    cursor = predecessor;
  }
  return Boolean(
    cursor.digest &&
      cursor.digest === auditEventDigest(cursor, AUDIT_CHAIN_GENESIS),
  );
}

async function linkedAudit(
  ctx: AppContext,
  intent: OrganizationWithdrawalAuditIntent,
): Promise<boolean> {
  const expected = eventInput(intent);
  const event = await ctx.repos.auditEvents.getById(expected.id);
  const metadata = redactAuditMetadata(expected.metadata);
  if (
    !event ||
    event.eventType !== expected.eventType ||
    event.outcome !== expected.outcome ||
    event.actorType !== expected.actorType ||
    event.principalId !== scrubText(expected.principalId) ||
    event.organizationId !== expected.organizationId ||
    event.correlationId !== expected.correlationId ||
    Object.entries(metadata).some(
      ([key, value]) => event.metadata[key] !== value,
    ) ||
    !event.previousDigest ||
    event.digest !== auditEventDigest(event, event.previousDigest)
  )
    return false;
  return belongsToAuditChain(ctx, event);
}

/** Append exactly once and discard the intent only after its chain is verified. */
export async function finishOrganizationWithdrawalAudit(
  ctx: AppContext,
  intent: OrganizationWithdrawalAuditIntent,
): Promise<void> {
  validate(intent);
  const input = eventInput(intent);
  if (!(await ctx.repos.auditEvents.getById(input.id))) {
    try {
      await appendAuditEvent(ctx.repos.auditEvents, input);
    } catch (error) {
      if (!(await linkedAudit(ctx, intent))) throw error;
    }
  }
  if (!(await linkedAudit(ctx, intent)))
    throw new Error("Conflicting organization withdrawal audit event");
  await ctx.stores.organizationWithdrawalAudits.delete(intent.id);
}

export async function resumePendingOrganizationWithdrawalAudits(
  ctx: AppContext,
): Promise<void> {
  for (const intent of await ctx.stores.organizationWithdrawalAudits.values()) {
    await finishOrganizationWithdrawalAudit(ctx, intent);
  }
}
