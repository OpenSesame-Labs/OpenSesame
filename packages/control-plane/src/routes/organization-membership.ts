import type { Named } from "@gdp-ts/core";
import { appendAuditEvent } from "@opensesame/audit";
import type {
  Organization,
  OrganizationMembership,
  OrganizationRole,
} from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import type { OrganizationId } from "../lib/ids.js";
import type { OrgOwner } from "../proofs/org-owner.js";
import {
  advancePrincipalSessionEpoch,
  advancePrincipalSessionEpochOn,
  withPrincipalSessionBoundary,
} from "../repos/principal-session-boundary.js";
import { removeOrganizationMembership } from "../services/org-admin.js";

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
  advanceEpochWithoutMembership?: boolean;
};

export type OrganizationRevocationResult = {
  membershipRemoved: boolean;
};

/** Drop a membership and every session it authorized (ADR 0056/0057). */
async function revokeSerializedOrganizationMembership(
  ctx: AppContext,
  input: OrganizationRevocationInput,
  removeMembership?: (ctx: AppContext) => Promise<boolean>,
): Promise<OrganizationRevocationResult> {
  const result = await withPrincipalSessionBoundary(
    ctx.stores,
    input.principalId,
    "revoke",
    async (stores, database) => {
      const transactionContext = { ...ctx, stores };
      const membershipRemoved = removeMembership
        ? await removeMembership(transactionContext)
        : await stores.organizationMemberships.remove(
            input.organizationId,
            input.principalId,
          );
      if (membershipRemoved || input.advanceEpochWithoutMembership) {
        if (database)
          await advancePrincipalSessionEpochOn(database, input.principalId);
        else await advancePrincipalSessionEpoch(stores, input.principalId);
      }
      return { membershipRemoved };
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
    },
  });
  return result;
}

/** System path: always acquire organization authority before principal authority. */
export function revokeOrganizationMembership(
  ctx: AppContext,
  input: OrganizationRevocationInput,
): Promise<OrganizationRevocationResult> {
  return serializeMembershipMutation(ctx, input.organizationId, () =>
    revokeSerializedOrganizationMembership(ctx, input),
  );
}

/** Owner path: bind the owner proof to the organization being removed from. */
export function revokeOwnedOrganizationMembership<A, O>(
  ctx: AppContext,
  org: Named<O, OrganizationId>,
  proof: OrgOwner<A, O>,
  input: Omit<OrganizationRevocationInput, "organizationId">,
): Promise<OrganizationRevocationResult> {
  return revokeSerializedOrganizationMembership(
    ctx,
    { ...input, organizationId: org.value },
    (transactionContext) =>
      removeOrganizationMembership(
        transactionContext,
        org,
        proof,
        input.principalId,
      ),
  );
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
};

export type JitJoinResult =
  | { ok: true; membership: OrganizationMembership; created: boolean }
  | { ok: false; error: "not_provisioned" | "last_owner"; message: string };

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
  const org = input.organization;
  if (org.provisioningEnabled) {
    const provisioned = await ctx.stores.scim.users.findBySubject(
      org.id,
      input.subject,
    );
    if (!provisioned?.active) {
      return {
        ok: false,
        error: "not_provisioned",
        message: "This organization provisions members through its directory.",
      };
    }
  }

  return serializeMembershipMutation(ctx, org.id, async () => {
    const existing = await getMembership(ctx, org.id, input.principalId);
    if (existing) {
      if (input.role !== undefined && input.role !== existing.role) {
        if (
          existing.role === "owner" &&
          (await ctx.stores.organizationMemberships.countOwners(org.id)) === 1
        ) {
          return {
            ok: false,
            error: "last_owner",
            message:
              "The directory would leave this organization without an owner.",
          };
        }
        const changed = await ctx.stores.organizationMemberships.upsert({
          ...existing,
          role: input.role,
          updatedAt: ctx.clock(),
        });
        await appendAuditEvent(ctx.repos.auditEvents, {
          eventType: "organization.member_role_changed",
          outcome: "succeeded",
          principalId: input.principalId,
          organizationId: org.id,
          correlationId: input.correlationId,
          metadata: {
            action: "organization.member.role.directory",
            previousRole: existing.role,
            role: changed.role,
          },
        });
        return { ok: true as const, membership: changed, created: false };
      }
      return { ok: true as const, membership: existing, created: false };
    }

    const now = ctx.clock();
    const membership = await ctx.stores.organizationMemberships.upsert({
      organizationId: org.id,
      principalId: input.principalId,
      role: input.role ?? "member",
      createdAt: now,
      updatedAt: now,
    });
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "organization.member_joined",
      outcome: "succeeded",
      principalId: input.principalId,
      organizationId: org.id,
      correlationId: input.correlationId,
      metadata: {
        action: "organization.tenant.join",
        method: input.method,
      },
    });
    return { ok: true as const, membership, created: true };
  });
}
