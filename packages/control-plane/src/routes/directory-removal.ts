import type { AppContext } from "../context.js";
import {
  advancePrincipalSessionEpoch,
  advancePrincipalSessionEpochOn,
  withPrincipalSessionBoundary,
} from "../repos/principal-session-boundary.js";
import { withScimOrganizationBoundary } from "../repos/scim-organization-boundary.js";
import {
  finishOrganizationWithdrawal,
  prepareRemovalWithdrawal,
} from "../services/organization-withdrawal.js";

export type DirectoryRemoval = {
  organizationId: string;
  principalId: string;
  incarnation: string;
  correlationId: string;
  reason: "scim_deactivated" | "ldap_directory_sync";
  /**
   * A journal resume can find the membership row already withdrawn. The retry
   * must still advance the principal session publication fence, without
   * turning one organization's event into a principal-wide logout.
   */
  advanceEpochWithoutMembership?: boolean;
};

/** Persist the removal fence inside the caller's organization transaction. */
export function prepareDirectoryRemoval(
  ctx: AppContext,
  input: DirectoryRemoval,
) {
  return prepareRemovalWithdrawal(ctx, {
    organizationId: input.organizationId,
    principalId: input.principalId,
    expectedIncarnation: input.incarnation,
    actorPrincipalId: ctx.systemOwnerPrincipalId,
    actorType: "system",
    correlationId: input.correlationId,
    reason: input.reason,
  });
}

/** Withdraw exactly the membership observed by a directory reconciliation. */
export async function removeDirectoryMembership(
  ctx: AppContext,
  input: DirectoryRemoval,
): Promise<boolean> {
  const prepared = await withScimOrganizationBoundary(
    ctx,
    input.organizationId,
    (tx) => prepareDirectoryRemoval(tx, input),
  );
  if (prepared.status === "missing") {
    if (input.advanceEpochWithoutMembership) {
      const current = await ctx.stores.organizationMemberships.find(
        input.organizationId,
        input.principalId,
      );
      // Only a retry whose row is truly absent advances the fence; a row
      // re-created under a new incarnation belongs to a different membership.
      if (!current) await advanceDirectoryEpoch(ctx, input.principalId);
    }
    return false;
  }
  if (prepared.status !== "ready")
    throw new Error(
      "Directory membership removal is pending; retry the request",
    );
  const result = await finishOrganizationWithdrawal(ctx, prepared.prepared);
  if (result.status === "removed") return true;
  if (result.status === "stale") {
    const current = await ctx.stores.organizationMemberships.findVersioned(
      input.organizationId,
      input.principalId,
    );
    if (!current || current.incarnation !== input.incarnation) return false;
  }
  throw new Error("Directory membership removal is pending; retry the request");
}

/** Advance the principal session fence without touching membership rows. */
async function advanceDirectoryEpoch(
  ctx: AppContext,
  principalId: string,
): Promise<void> {
  await withPrincipalSessionBoundary(
    ctx.stores,
    principalId,
    "revoke",
    async (stores, database) => {
      if (database) await advancePrincipalSessionEpochOn(database, principalId);
      else await advancePrincipalSessionEpoch(stores, principalId);
    },
  );
}

export async function removeLdapMembership(
  ctx: AppContext,
  organizationId: string,
  principalId: string,
): Promise<boolean> {
  const current = await ctx.stores.organizationMemberships.findVersioned(
    organizationId,
    principalId,
  );
  if (!current) return false;
  return removeDirectoryMembership(ctx, {
    organizationId,
    principalId,
    incarnation: current.incarnation,
    correlationId: `ldap-sync-${organizationId}`,
    reason: "ldap_directory_sync",
  });
}
