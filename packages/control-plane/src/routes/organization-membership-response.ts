import { OrganizationMembershipResponseSchema } from "@opensesame/contracts";
import type { OrganizationMembership } from "@opensesame/os-domain";

export function membershipResponse(membership: OrganizationMembership) {
  return OrganizationMembershipResponseSchema.parse({
    ...membership,
    createdAt: membership.createdAt.toISOString(),
    updatedAt: membership.updatedAt.toISOString(),
  });
}
