import { appendAuditEvent } from "@opensesame/audit";
import type {
  Organization,
  OrganizationMembership,
  OrganizationRole,
} from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import {
  advancePrincipalSessionEpoch,
  advancePrincipalSessionEpochOn,
  withPrincipalSessionBoundary,
} from "../repos/principal-session-boundary.js";
import { removeOrphanTokens } from "../repos/session-storage.js";
import { withScimOrganizationBoundary } from "../repos/scim-organization-boundary.js";
import {
  type PreparedWithdrawal,
  finishOrganizationWithdrawal,
  prepareRoleWithdrawal,
} from "../services/organization-withdrawal.js";
import { roleOf } from "./scim-effects.js";

export async function getMembership(
  ctx: AppContext,
  organizationId: string,
  principalId: string,
): Promise<OrganizationMembership | undefined> {
  return ctx.stores.organizationMemberships.find(organizationId, principalId);
}

export async function serializeMembershipMutation<T>(
  ctx: AppContext,
  organizationId: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const previous =
    ctx.stores.organizationMembershipMutations.get(organizationId) ??
    Promise.resolve();
  let release = () => {};
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => turn);
  ctx.stores.organizationMembershipMutations.set(organizationId, tail);
  await previous;
  try {
    return await mutation();
  } finally {
    release();
    if (
      ctx.stores.organizationMembershipMutations.get(organizationId) === tail
    ) {
      ctx.stores.organizationMembershipMutations.delete(organizationId);
    }
  }
}

export type OrganizationRevocationInput = {
  organizationId: string;
  principalId: string;
  correlationId: string;
  reason: string;
  revokeSessionsWithoutMembership?: boolean;
  /** Internal: caller already owns this organization's mutation turn. */
  membershipSerialized?: boolean;
};

export type OrganizationRevocationResult = {
  membershipRemoved: boolean;
  sessionsRevoked: number;
};

/** Drop a membership and every session it authorized (ADR 0056/0057). */
export async function revokeOrganizationMembership(
  ctx: AppContext,
  input: OrganizationRevocationInput,
): Promise<OrganizationRevocationResult> {
  const result = await withPrincipalSessionBoundary(
    ctx.stores,
    input.principalId,
    "revoke",
    async (stores, database) => {
      const remove = async () =>
        await stores.organizationMemberships.remove(
          input.organizationId,
          input.principalId,
        );
      const membershipRemoved = input.membershipSerialized
        ? await remove()
        : await serializeMembershipMutation(
            { ...ctx, stores },
            input.organizationId,
            remove,
          );
      if (membershipRemoved || input.revokeSessionsWithoutMembership) {
        if (database)
          await advancePrincipalSessionEpochOn(database, input.principalId);
        else await advancePrincipalSessionEpoch(stores, input.principalId);
      }
      let sessionsRevoked = 0;
      const sessions =
        membershipRemoved || input.revokeSessionsWithoutMembership
          ? await stores.provisionalSessions.entries()
          : [];
      for (const [, session] of sessions) {
        if (session.principalId !== input.principalId) continue;
        await stores.provisionalSessions.delete(session.id);
        sessionsRevoked += 1;
      }
      await removeOrphanTokens(stores);
      return { membershipRemoved, sessionsRevoked };
    },
  );
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "organization.member_revoked",
    outcome: "succeeded",
    principalId: input.principalId,
    organizationId: input.organizationId,
    correlationId: input.correlationId,
    metadata: {
      action: "organization.member.revoke",
      reason: input.reason,
      count: result.sessionsRevoked,
    },
  });
  return result;
}

export type JitJoinInput = {
  organization: Organization;
  principalId: string;
  /** The upstream subject that authenticated this sign-in. */
  subject: string;
  /** How the subject authenticated — recorded on the audit row. */
  method: string;
  correlationId: string;
  role?: OrganizationRole;
  /** LDAP groups supplied the role directly, instead of a prior SCIM read. */
  roleSource?: "ldap";
};

export type JitJoinResult =
  | { ok: true; membership: OrganizationMembership; created: boolean }
  | {
      ok: false;
      error:
        | "not_provisioned"
        | "last_owner"
        | "membership_withdrawing"
        | "organization_unavailable";
      message: string;
    };

/**
 * Join an authenticated subject to a tenant (ADR 0055/0056).
 *
 * Shared deliberately: the tenant join route and the hosted login page's
 * completion path must agree on membership and on what the trail records, or
 * where you signed in decides whether you are a member. When the tenant marks
 * SCIM authoritative, the directory — not the IdP — decides: a subject with no
 * active provisioned row is refused even though its assertion verified, which
 * is the whole point of directory-driven deprovisioning.
 */
export async function jitJoinOrganization(
  ctx: AppContext,
  input: JitJoinInput,
): Promise<JitJoinResult> {
  const result = await withScimOrganizationBoundary(
    ctx,
    input.organization.id,
    (tx) => prepareJoin(tx, input),
  );
  if ("prepared" in result) {
    const finished = await finishOrganizationWithdrawal(ctx, result.prepared);
    if (finished.status !== "changed") return busy();
    return withScimOrganizationBoundary(ctx, input.organization.id, (tx) =>
      revalidateJoin(tx, input, result.prepared.incarnation),
    );
  }
  if (result.ok && result.created) {
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "organization.member_joined",
      outcome: "succeeded",
      principalId: input.principalId,
      organizationId: input.organization.id,
      correlationId: input.correlationId,
      metadata: { action: "organization.tenant.join", method: input.method },
    });
  }
  return result;
}

type PreparedJoin = JitJoinResult | { prepared: PreparedWithdrawal };

function busy(): JitJoinResult {
  return {
    ok: false,
    error: "membership_withdrawing",
    message: "Membership update is in progress. Try again later.",
  };
}

async function prepareJoin(
  tx: AppContext,
  input: JitJoinInput,
): Promise<PreparedJoin> {
  const orgId = input.organization.id;
  const currentOrg = await tx.stores.organizations.get(orgId);
  if (currentOrg?.state !== "active") {
    return {
      ok: false,
      error: "organization_unavailable",
      message: "This organization is unavailable.",
    };
  }
  const provisioned = await tx.stores.scim.users.findBySubject(
    orgId,
    input.subject,
  );
  if (currentOrg.provisioningEnabled && !provisioned?.active) {
    return {
      ok: false,
      error: "not_provisioned",
      message: "This organization provisions members through its directory.",
    };
  }
  const role =
    input.roleSource === "ldap"
      ? input.role
      : provisioned?.active
        ? roleOf(provisioned)
        : undefined;
  return serializeMembershipMutation(tx, orgId, async () => {
    const current = await tx.stores.organizationMemberships.findVersioned(
      orgId,
      input.principalId,
    );
    if (current) {
      if (
        current.withdrawalId ||
        (role !== undefined && role !== current.membership.role)
      ) {
        if (role === undefined) return busy();
        return prepareJoinRole(tx, input, current.incarnation, role);
      }
      return { ok: true, membership: current.membership, created: false };
    }
    const now = tx.clock();
    const membership = await tx.stores.organizationMemberships.upsert({
      organizationId: orgId,
      principalId: input.principalId,
      role: role ?? "member",
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true, membership, created: true };
  });
}

async function prepareJoinRole(
  tx: AppContext,
  input: JitJoinInput,
  incarnation: string,
  role: OrganizationRole,
): Promise<PreparedJoin> {
  const result = await prepareRoleWithdrawal(tx, {
    organizationId: input.organization.id,
    principalId: input.principalId,
    expectedIncarnation: incarnation,
    role,
    actorPrincipalId: input.principalId,
    actorType: "system",
    correlationId: input.correlationId,
  });
  if (result.status === "ready") return { prepared: result.prepared };
  if (result.status === "unchanged")
    return { ok: true, membership: result.membership, created: false };
  if (result.status === "last_owner")
    return {
      ok: false,
      error: "last_owner",
      message: "The directory would leave this organization without an owner.",
    };
  return busy();
}

async function revalidateJoin(
  tx: AppContext,
  input: JitJoinInput,
  incarnation: string,
): Promise<JitJoinResult> {
  const orgId = input.organization.id;
  const org = await tx.stores.organizations.get(orgId);
  const provisioned = await tx.stores.scim.users.findBySubject(
    orgId,
    input.subject,
  );
  const current = await tx.stores.organizationMemberships.findVersioned(
    orgId,
    input.principalId,
  );
  if (
    org?.state !== "active" ||
    (org.provisioningEnabled && !provisioned?.active)
  ) {
    return {
      ok: false,
      error: "not_provisioned",
      message: "This organization provisions members through its directory.",
    };
  }
  if (!current || current.withdrawalId || current.incarnation !== incarnation)
    return busy();
  return { ok: true, membership: current.membership, created: false };
}
