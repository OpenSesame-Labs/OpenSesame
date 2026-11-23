import { name } from "@gdp-ts/core";
import type { OrganizationRole } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import { actorId, organizationId } from "../lib/ids.js";
import { activeOrgOwner } from "../proofs/org-owner.js";
import { putGroupRoleMapping } from "../routes/scim-groups.js";

/**
 * Map a directory group to a role the way an owner would: the proof comes from
 * the real prover, against a real owner membership, never from a cast. A suite
 * that seeded no owner fails here instead of writing the mapping anyway.
 */
export async function putGroupRoleMappingAsOwner(
  ctx: AppContext,
  orgId: string,
  groupId: string,
  role: OrganizationRole,
): Promise<void> {
  const members =
    await ctx.stores.organizationMemberships.listByOrganization(orgId);
  const owner = members.find((member) => member.role === "owner");
  if (!owner) throw new Error(`organization ${orgId} has no owner`);
  return name(
    actorId(owner.principalId),
    organizationId(orgId),
    async (actor, org) => {
      const verdict = await activeOrgOwner(ctx.stores, actor, org);
      if (!verdict.ok) throw new Error(`owner refused: ${verdict.error}`);
      const result = await putGroupRoleMapping(
        ctx,
        actor,
        org,
        verdict.proof,
        groupId,
        role,
      );
      if (!result.ok) throw new Error(`owner refused: ${result.error}`);
    },
  );
}
