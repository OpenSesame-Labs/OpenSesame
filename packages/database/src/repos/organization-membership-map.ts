import {
  type OrganizationMembership,
  overlapCast,
} from "@opensesame/os-domain";
import type * as schema from "../schema/index.js";
import type {
  OrganizationMembershipWithdrawal,
  VersionedOrganizationMembership,
} from "./organization-interfaces.js";
import { validOrganizationWithdrawal } from "./organization-withdrawal.js";

export function mapOrganizationMembership(
  row: typeof schema.organizationMemberships.$inferSelect,
): OrganizationMembership {
  return {
    organizationId: row.organizationId,
    principalId: row.principalId,
    role: overlapCast(row.role),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function mapVersionedMembership(
  row: typeof schema.organizationMemberships.$inferSelect,
): VersionedOrganizationMembership {
  let withdrawal: OrganizationMembershipWithdrawal | undefined;
  if (row.withdrawalId) {
    if (
      (row.withdrawalActorType !== "human" &&
        row.withdrawalActorType !== "system") ||
      row.withdrawalActorPrincipalId === null ||
      row.withdrawalCorrelationId === null
    ) {
      throw new Error("membership withdrawal metadata is missing");
    }
    const base = {
      id: row.withdrawalId,
      actorType:
        row.withdrawalActorType === "human"
          ? ("human" as const)
          : ("system" as const),
      actorPrincipalId: row.withdrawalActorPrincipalId,
      correlationId: row.withdrawalCorrelationId,
    };
    if (row.withdrawalKind === "remove")
      withdrawal = {
        ...base,
        kind: "remove",
        ...(row.withdrawalReason
          ? { reason: overlapCast(row.withdrawalReason) }
          : undefined),
      };
    else if (row.withdrawalKind === "change_role" && row.withdrawalRole) {
      withdrawal = {
        ...base,
        kind: "change_role",
        role: overlapCast(row.withdrawalRole),
      };
    } else throw new Error("membership withdrawal intent is invalid");
    if (!withdrawal || !validOrganizationWithdrawal(withdrawal))
      throw new Error("membership withdrawal intent is invalid");
  }
  return {
    membership: mapOrganizationMembership(row),
    incarnation: row.incarnation,
    authorityRevision: row.authorityRevision,
    ...(withdrawal ? { withdrawalId: withdrawal.id, withdrawal } : undefined),
  };
}
