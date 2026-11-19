import { randomUUID } from "node:crypto";
import type {
  OrganizationMembershipWithdrawal,
  PendingOrganizationMembershipWithdrawal,
} from "@opensesame/database";
import { MemoryOrganizationMembershipStore } from "@opensesame/database";
import type {
  OrganizationMembership,
  OrganizationRole,
} from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import {
  type OrganizationWithdrawalAuditIntent,
  finishOrganizationWithdrawalAudit,
} from "../repos/organization-withdrawal-audit.js";
import { withPrincipalSessionBoundary } from "../repos/principal-session-boundary.js";
import { revokeOrganizationMembership } from "../routes/organization-revocation.js";
import { hostApiEndpoint } from "./host-endpoint.js";

export type PreparedWithdrawal = PendingOrganizationMembershipWithdrawal;
export type PrepareWithdrawalResult =
  | { status: "ready"; prepared: PreparedWithdrawal }
  | { status: "unchanged"; membership: OrganizationMembership }
  | { status: "missing" }
  | { status: "last_owner" }
  | { status: "busy" };

type WithdrawalInput = {
  organizationId: string;
  principalId: string;
  expectedIncarnation?: string;
  actorPrincipalId: string;
  actorType: "human" | "system";
  correlationId: string;
  reason?:
    | "organization_owner_removed"
    | "scim_deactivated"
    | "ldap_directory_sync";
};

type Request =
  | { kind: "remove" }
  | { kind: "change_role"; role: OrganizationRole };

/** Must run inside the caller's organization boundary and commit before Host I/O. */
async function prepareWithdrawal(
  tx: AppContext,
  input: WithdrawalInput,
  request: Request,
  attempts = 0,
): Promise<PrepareWithdrawalResult> {
  const store = tx.stores.organizationMemberships;
  const current = await store.findVersioned(
    input.organizationId,
    input.principalId,
  );
  if (
    !current ||
    (input.expectedIncarnation &&
      current.incarnation !== input.expectedIncarnation)
  )
    return { status: "missing" };
  if (current.withdrawal) {
    if (
      request.kind === "remove" &&
      input.actorType === "system" &&
      current.withdrawal.kind === "change_role" &&
      current.withdrawalId
    ) {
      // A directory deactivation supersedes a pending role change without
      // opening a gap in the fence or changing the Host tombstone tuple.
      const withdrawal: OrganizationMembershipWithdrawal = {
        id: current.withdrawalId,
        kind: "remove",
        actorType: "system",
        actorPrincipalId: input.actorPrincipalId,
        correlationId: input.correlationId,
        ...(input.reason ? { reason: input.reason } : {}),
      };
      const upgraded = await store.upgradeRoleWithdrawalToRemoval(
        input.organizationId,
        input.principalId,
        current.incarnation,
        current.authorityRevision,
        current.withdrawalId,
        withdrawal,
      );
      if (upgraded) {
        return {
          status: "ready",
          prepared: { ...current, withdrawalId: withdrawal.id, withdrawal },
        };
      }
      // A role completion may have won the CAS; fence the resulting revision
      // before allowing the directory's deactivation transaction to commit.
      return attempts < 2
        ? prepareWithdrawal(tx, input, request, attempts + 1)
        : { status: "busy" };
    }
    const same =
      current.withdrawal.kind === request.kind &&
      current.withdrawal.actorType === input.actorType &&
      (request.kind !== "remove" ||
        current.withdrawal.reason === input.reason) &&
      (request.kind !== "change_role" ||
        (current.withdrawal.kind === "change_role" &&
          current.withdrawal.role === request.role));
    return same && current.withdrawalId
      ? {
          status: "ready",
          prepared: {
            ...current,
            withdrawalId: current.withdrawalId,
            withdrawal: current.withdrawal,
          },
        }
      : { status: "busy" };
  }
  if (current.withdrawalId) return { status: "busy" };
  if (
    request.kind === "change_role" &&
    current.membership.role === request.role
  )
    return { status: "unchanged", membership: current.membership };
  if (
    current.membership.role === "owner" &&
    !(request.kind === "remove" && input.actorType === "system")
  ) {
    // Withdrawing owners cannot authorize work and may soon disappear. Count
    // only owners that will remain after all already-prepared changes finish.
    const remaining = (
      await store.listVersionedByOrganization(input.organizationId)
    ).filter(
      (candidate) =>
        candidate.membership.role === "owner" &&
        !candidate.withdrawalId &&
        candidate.incarnation !== current.incarnation,
    );
    if (remaining.length === 0) return { status: "last_owner" };
  }

  const details = {
    id: randomUUID(),
    actorPrincipalId: input.actorPrincipalId,
    actorType: input.actorType,
    correlationId: input.correlationId,
  };
  const withdrawal: OrganizationMembershipWithdrawal =
    request.kind === "remove"
      ? {
          ...details,
          kind: "remove",
          ...(input.reason ? { reason: input.reason } : {}),
        }
      : { ...details, kind: "change_role", role: request.role };
  if (
    !(await store.beginWithdrawal(
      input.organizationId,
      input.principalId,
      current.incarnation,
      current.authorityRevision,
      withdrawal,
    ))
  )
    return { status: "busy" };
  return {
    status: "ready",
    prepared: { ...current, withdrawalId: withdrawal.id, withdrawal },
  };
}

export function prepareRoleWithdrawal(
  tx: AppContext,
  input: WithdrawalInput & { role: OrganizationRole },
): Promise<PrepareWithdrawalResult> {
  return prepareWithdrawal(tx, input, {
    kind: "change_role",
    role: input.role,
  });
}

export function prepareRemovalWithdrawal(
  tx: AppContext,
  input: WithdrawalInput,
): Promise<PrepareWithdrawalResult> {
  return prepareWithdrawal(tx, input, { kind: "remove" });
}

export type FinishWithdrawalResult =
  | { status: "removed" }
  | { status: "changed"; membership: OrganizationMembership }
  | { status: "pending" }
  | { status: "stale" };

async function revokeHost(
  ctx: AppContext,
  prepared: PreparedWithdrawal,
): Promise<boolean> {
  const url = hostApiEndpoint(ctx.config.hostApiUrl, "api/v1/sessions/revoke");
  if (!url) return false;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opensesame-operator": ctx.config.operatorToken,
      },
      body: JSON.stringify({
        organization_id: prepared.membership.organizationId,
        principal_id: prepared.membership.principalId,
        membership_incarnation: prepared.incarnation,
        authority_revision: prepared.authorityRevision,
        withdrawal_id: prepared.withdrawal.id,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    ctx.log.warn("Host session revocation failed");
    return false;
  }
}

function withdrawalAudit(
  prepared: PreparedWithdrawal,
): OrganizationWithdrawalAuditIntent {
  const { membership, withdrawal } = prepared;
  return {
    id: withdrawal.id,
    actorPrincipalId: withdrawal.actorPrincipalId,
    actorType: withdrawal.actorType,
    organizationId: membership.organizationId,
    principalId: membership.principalId,
    correlationId: withdrawal.correlationId,
    previousRole: membership.role,
    ...(withdrawal.kind === "remove"
      ? { kind: "remove" as const }
      : { kind: "change_role" as const, role: withdrawal.role }),
  };
}

async function completeRole(
  ctx: AppContext,
  prepared: PreparedWithdrawal,
  audit: OrganizationWithdrawalAuditIntent,
) {
  const { membership, withdrawal, incarnation, authorityRevision } = prepared;
  if (withdrawal.kind !== "change_role")
    throw new Error("Expected role withdrawal");
  return withPrincipalSessionBoundary(
    ctx.stores,
    membership.principalId,
    "revoke",
    async (stores) => {
      const store = stores.organizationMemberships;
      const audits = stores.organizationWithdrawalAudits;
      if (
        store instanceof MemoryOrganizationMembershipStore &&
        audits instanceof Map
      ) {
        const current = store.findVersioned(
          membership.organizationId,
          membership.principalId,
        );
        if (
          current?.incarnation !== incarnation ||
          current.withdrawalId !== withdrawal.id ||
          current.authorityRevision !== authorityRevision
        )
          return undefined;
        // The memory backend writes synchronously, so no other task can observe a
        // completed membership without its audit intent.
        audits.set(audit.id, audit);
        try {
          const updated = store.completeRoleWithdrawal(
            membership.organizationId,
            membership.principalId,
            incarnation,
            withdrawal.id,
            withdrawal.role,
            ctx.clock(),
          );
          if (!updated) audits.delete(audit.id);
          return updated;
        } catch (error) {
          audits.delete(audit.id);
          throw error;
        }
      }
      const updated = await store.completeRoleWithdrawal(
        membership.organizationId,
        membership.principalId,
        incarnation,
        withdrawal.id,
        withdrawal.role,
        ctx.clock(),
      );
      if (updated) await audits.set(audit.id, audit);
      return updated;
    },
  );
}

/** Resume exactly one already-authorized durable withdrawal. */
export async function finishOrganizationWithdrawal(
  ctx: AppContext,
  prepared: PreparedWithdrawal,
): Promise<FinishWithdrawalResult> {
  const { membership, withdrawal, incarnation, authorityRevision } = prepared;
  const current = await ctx.stores.organizationMemberships.findVersioned(
    membership.organizationId,
    membership.principalId,
  );
  if (!current)
    return { status: withdrawal.kind === "remove" ? "removed" : "stale" };
  if (current.incarnation !== incarnation) return { status: "stale" };
  if (
    !current.withdrawal &&
    withdrawal.kind === "change_role" &&
    current.membership.role === withdrawal.role &&
    current.authorityRevision !== authorityRevision
  )
    return { status: "changed", membership: current.membership };
  if (
    current.withdrawalId !== withdrawal.id ||
    current.authorityRevision !== authorityRevision ||
    current.withdrawal?.kind !== withdrawal.kind ||
    (withdrawal.kind === "change_role" &&
      (current.withdrawal.kind !== "change_role" ||
        current.withdrawal.role !== withdrawal.role))
  )
    return { status: "stale" };
  // A timeout can mean Host committed but the response was lost. Keep the same
  // intent fenced and retry its idempotency key until Host confirms success.
  if (!(await revokeHost(ctx, prepared))) return { status: "pending" };
  const audit = withdrawalAudit(prepared);

  if (withdrawal.kind === "remove") {
    const result = await revokeOrganizationMembership(ctx, {
      organizationId: membership.organizationId,
      principalId: membership.principalId,
      correlationId: withdrawal.correlationId,
      reason:
        withdrawal.reason ??
        (withdrawal.actorType === "system"
          ? "organization_deprovisioned"
          : "organization_owner_removed"),
      expectedIncarnation: incarnation,
      expectedWithdrawalId: withdrawal.id,
      withdrawalAudit: audit,
    });
    if (!result.membershipRemoved) {
      const after = await ctx.stores.organizationMemberships.findVersioned(
        membership.organizationId,
        membership.principalId,
      );
      return { status: after ? "stale" : "removed" };
    }
    await finishOrganizationWithdrawalAudit(ctx, audit);
    return { status: "removed" };
  }

  const updated = await completeRole(ctx, prepared, audit);
  if (!updated) {
    const after = await ctx.stores.organizationMemberships.findVersioned(
      membership.organizationId,
      membership.principalId,
    );
    return after &&
      after.incarnation === incarnation &&
      !after.withdrawalId &&
      after.authorityRevision !== authorityRevision &&
      after.membership.role === withdrawal.role
      ? { status: "changed", membership: after.membership }
      : { status: "stale" };
  }
  await finishOrganizationWithdrawalAudit(ctx, audit);
  return { status: "changed", membership: updated.membership };
}
