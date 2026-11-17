import type { OrganizationMembership } from "@opensesame/os-domain";

export function organizationMembershipKey(
  organizationId: string,
  principalId: string,
): string {
  return `${organizationId}:${principalId}`;
}

export function cloneMembership(
  row: OrganizationMembership,
): OrganizationMembership {
  return {
    ...row,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}
