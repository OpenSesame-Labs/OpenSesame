import { randomUUID } from "node:crypto";
import { MemoryOrganizationMembershipStore } from "@opensesame/database";
import type { ProvisionalSession } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import { DurableMap } from "../repos/durable-map.js";
import {
  type OrganizationRevocationAuditIntent,
  finishOrganizationRevocationAudit,
} from "../repos/organization-revocation-audit.js";
import type { OrganizationWithdrawalAuditIntent } from "../repos/organization-withdrawal-audit.js";
import { withPrincipalSessionBoundary } from "../repos/principal-session-boundary.js";
import {
  beginProvisionalRevocationBatch,
  finishProvisionalRevocation,
} from "../repos/provisional-revocation.js";
import type { AppStores } from "../state.js";

export type OrganizationRevocationInput = {
  organizationId: string;
  principalId: string;
  correlationId: string;
  reason: string;
  expectedIncarnation?: string;
  expectedWithdrawalId?: string;
  withdrawalAudit?: OrganizationWithdrawalAuditIntent;
  revokeSessionsWithoutMembership?: boolean;
};
export class OrganizationRevocationBusyError extends Error {
  override readonly name = "OrganizationRevocationBusyError";
  constructor() {
    super("The membership is being withdrawn; retry deprovisioning.");
  }
}
export type OrganizationRevocationResult = {
  membershipRemoved: boolean;
  sessionsRevoked: number;
};
type Transition = {
  membershipRemoved: boolean;
  sessions: ProvisionalSession[];
  transitioned: ReadonlyMap<string, boolean>;
  audit?: OrganizationRevocationAuditIntent;
};
const empty = (): Transition => ({
  membershipRemoved: false,
  sessions: [],
  transitioned: new Map(),
});

function auditIntent(
  input: OrganizationRevocationInput,
  count: number,
): OrganizationRevocationAuditIntent {
  return {
    id: randomUUID(),
    principalId: input.principalId,
    organizationId: input.organizationId,
    correlationId: input.correlationId,
    reason: input.reason,
    count,
  };
}

function pendingSession(
  session: ProvisionalSession,
  input: OrganizationRevocationInput,
  now: Date,
): ProvisionalSession {
  return {
    ...session,
    revokedAt: session.revokedAt ?? now,
    revocationCleanupPending: true,
    revocationCleanup: session.revocationCleanup ?? {
      actorType: "system",
      correlationId: input.correlationId,
      metadata: {
        action: "principal.provisional_revoke",
        organizationId: input.organizationId,
        reason: input.reason,
      },
    },
  };
}

function memorySessionChanges(
  ctx: AppContext,
  sessions: Map<string, ProvisionalSession>,
  input: OrganizationRevocationInput,
  candidates: ProvisionalSession[],
): { before: ProvisionalSession; after: ProvisionalSession }[] {
  return candidates.flatMap((candidate) => {
    const session = sessions.get(candidate.id);
    if (
      !session ||
      session.principalId !== input.principalId ||
      (session.revokedAt && !session.revocationCleanupPending)
    )
      return [];
    return [
      { before: session, after: pendingSession(session, input, ctx.clock()) },
    ];
  });
}

function memoryStores(stores: AppStores) {
  const memberships = stores.organizationMemberships;
  const sessions = stores.provisionalSessions;
  const audits = stores.organizationRevocationAudits;
  const withdrawalAudits = stores.organizationWithdrawalAudits;
  if (
    !(memberships instanceof MemoryOrganizationMembershipStore) ||
    !(sessions instanceof Map) ||
    !(audits instanceof Map) ||
    !(withdrawalAudits instanceof Map)
  )
    throw new Error("Expected memory session and membership stores");
  return { memberships, sessions, audits, withdrawalAudits };
}

// Prepare memory writes first, then apply them without yielding.
function transitionMemory(
  ctx: AppContext,
  input: OrganizationRevocationInput,
  incarnation: string,
  candidates: ProvisionalSession[],
): Transition {
  const { memberships, sessions, audits, withdrawalAudits } = memoryStores(
    ctx.stores,
  );
  const current = memberships.findVersioned(
    input.organizationId,
    input.principalId,
  );
  if (current?.incarnation !== incarnation) return empty();
  if (current.withdrawalId !== input.expectedWithdrawalId)
    throw new OrganizationRevocationBusyError();
  const changes = memorySessionChanges(ctx, sessions, input, candidates);
  const audit = auditIntent(
    input,
    changes.filter(({ before }) => !before.revokedAt).length,
  );
  if (input.withdrawalAudit && withdrawalAudits.has(input.withdrawalAudit.id))
    throw new Error("Withdrawal audit intent already exists");
  try {
    audits.set(audit.id, audit);
    if (input.withdrawalAudit)
      withdrawalAudits.set(input.withdrawalAudit.id, input.withdrawalAudit);
    for (const { after } of changes) sessions.set(after.id, after);
    if (
      !memberships.removeIfIncarnation(
        input.organizationId,
        input.principalId,
        incarnation,
        input.expectedWithdrawalId,
      )
    ) {
      throw new OrganizationRevocationBusyError();
    }
  } catch (error) {
    for (const { before } of changes) sessions.set(before.id, before);
    audits.delete(audit.id);
    if (input.withdrawalAudit)
      withdrawalAudits.delete(input.withdrawalAudit.id);
    throw error;
  }
  return {
    membershipRemoved: true,
    sessions: candidates,
    transitioned: new Map(
      changes.map(({ before }) => [before.id, !before.revokedAt]),
    ),
    audit,
  };
}

async function transitionDurable(
  ctx: AppContext,
  input: OrganizationRevocationInput,
  incarnation: string,
): Promise<Transition> {
  if (
    !(await ctx.stores.organizationMemberships.removeIfIncarnation(
      input.organizationId,
      input.principalId,
      incarnation,
      input.expectedWithdrawalId,
    ))
  ) {
    const current = await ctx.stores.organizationMemberships.findVersioned(
      input.organizationId,
      input.principalId,
    );
    if (current?.incarnation === incarnation)
      throw new OrganizationRevocationBusyError();
    return empty();
  }
  const sessions = [...(await ctx.stores.provisionalSessions.values())].filter(
    (session) => session.principalId === input.principalId,
  );
  const transitioned = await beginProvisionalRevocationBatch(
    ctx,
    sessions.map((session) => ({
      sessionId: session.id,
      audit: {
        actorType: "system" as const,
        correlationId: input.correlationId,
        metadata: {
          action: "principal.provisional_revoke",
          organizationId: input.organizationId,
          reason: input.reason,
        },
      },
    })),
  );
  const audit = auditIntent(
    input,
    [...transitioned.values()].filter(Boolean).length,
  );
  await ctx.stores.organizationRevocationAudits.set(audit.id, audit);
  if (input.withdrawalAudit) {
    const withdrawalAudits = ctx.stores.organizationWithdrawalAudits;
    if (!(withdrawalAudits instanceof DurableMap))
      throw new Error("Expected durable withdrawal audit store");
    if (
      !(await withdrawalAudits.claim(
        input.withdrawalAudit.id,
        input.withdrawalAudit,
      ))
    )
      throw new Error("Withdrawal audit intent already exists");
  }
  return { membershipRemoved: true, sessions, transitioned, audit };
}

async function transition(
  ctx: AppContext,
  stores: AppStores,
  input: OrganizationRevocationInput,
  incarnation: string,
): Promise<Transition> {
  const bound = { ...ctx, stores };
  if (!(stores.provisionalSessions instanceof Map))
    return transitionDurable(bound, input, incarnation);
  const sessions = [...(await stores.provisionalSessions.values())].filter(
    (session) => session.principalId === input.principalId,
  );
  return transitionMemory(bound, input, incarnation, sessions);
}

/** Atomically remove the selected membership and invalidate its sessions. */
export async function revokeOrganizationMembership(
  ctx: AppContext,
  input: OrganizationRevocationInput,
): Promise<OrganizationRevocationResult> {
  if (
    input.withdrawalAudit &&
    (input.withdrawalAudit.kind !== "remove" ||
      input.withdrawalAudit.id !== input.expectedWithdrawalId ||
      input.withdrawalAudit.organizationId !== input.organizationId ||
      input.withdrawalAudit.principalId !== input.principalId)
  )
    throw new Error("Invalid withdrawal audit intent");
  const incarnation =
    input.expectedIncarnation ??
    (
      await ctx.stores.organizationMemberships.findVersioned(
        input.organizationId,
        input.principalId,
      )
    )?.incarnation;
  if (!incarnation) return { membershipRemoved: false, sessionsRevoked: 0 };
  const result = await withPrincipalSessionBoundary(
    ctx.stores,
    input.principalId,
    "revoke",
    (stores) => transition(ctx, stores, input, incarnation),
  );
  for (const session of result.sessions)
    await finishProvisionalRevocation(ctx, session.id);
  const sessionsRevoked = [...result.transitioned.values()].filter(
    Boolean,
  ).length;
  if (result.audit) await finishOrganizationRevocationAudit(ctx, result.audit);
  return { membershipRemoved: result.membershipRemoved, sessionsRevoked };
}
