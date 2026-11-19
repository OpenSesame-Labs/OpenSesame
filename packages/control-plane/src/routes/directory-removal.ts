import type { AppContext } from "../context.js";
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
  if (prepared.status === "missing") return false;
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
