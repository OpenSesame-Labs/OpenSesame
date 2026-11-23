import { appendAuditEvent } from "@opensesame/audit";
import {
  SCIM_GROUP_MEMBERS_MAX,
  ScimAdminCapacityError,
  scimMappingAdmissible,
} from "@opensesame/database";
import {
  type OrganizationRole,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { asActiveOrgOwner } from "./org-owner-gate.js";
import {
  putGroupRoleMapping,
  removeNeutralGroupRoleMapping,
} from "./scim-groups.js";
import { scimOwnerPage } from "./scim-protocol.js";
import { consumeScimMutation } from "./scim-rate-limit.js";

export const scimMappingAdminRoutes = new Hono<{ Variables: Variables }>();

// A mapping can grant owner authority to provisioned users, so it has the same
// active-organization requirement as the SCIM provisioning routes.
const OWNER = {
  param: "organizationId",
};

scimMappingAdminRoutes.get(
  "/:organizationId/scim/mappings",
  requirePrincipal(),
  async (c) =>
    asActiveOrgOwner(c, OWNER, async ({ ctx, organization }) => {
      const page = scimOwnerPage(c);
      if (!page) return c.json({ error: "validation_error" }, 400);
      const totalResults = await ctx.stores.scim.mappings.count(
        organization.id,
      );
      if (!page.paged && totalResults > page.limit)
        return c.json({ error: "pagination_required", totalResults }, 409);
      const mappings =
        page.offset >= totalResults
          ? []
          : await ctx.stores.scim.mappings.listByOrganization(organization.id, {
              offset: page.offset,
              limit: page.limit,
            });
      return c.json({
        mappings,
        totalResults,
        startIndex: page.startIndex,
        itemsPerPage: mappings.length,
      });
    }),
);

scimMappingAdminRoutes.put(
  "/:organizationId/scim/mappings/:groupId",
  requirePrincipal(),
  async (c) =>
    asActiveOrgOwner(
      c,
      OWNER,
      async ({ ctx, actor, org, proof, organization }) => {
        const groupId = decodeURIComponent(c.req.param("groupId") ?? "");
        const body = overlapCast(await c.req.json().catch(() => ({})));
        const role = isString(body.role) ? body.role : "";
        if (
          !groupId ||
          (role !== "owner" && role !== "admin" && role !== "member")
        ) {
          return c.json({ error: "validation_error" }, 400);
        }
        const refused = await mappingRefusal(
          ctx,
          organization.id,
          groupId,
          role,
        );
        if (refused) {
          if (refused.status === 429) c.header("Retry-After", "60");
          return c.json({ error: refused.error }, refused.status);
        }
        const result = await putGroupRoleMapping(
          ctx,
          actor,
          org,
          proof,
          groupId,
          role,
        ).catch((error) => {
          if (error instanceof ScimAdminCapacityError)
            return {
              ok: false as const,
              status: 409 as const,
              error: "scim_mapping_capacity" as const,
            };
          throw error;
        });
        if (!result.ok) return c.json({ error: result.error }, result.status);
        await appendAuditEvent(ctx.repos.auditEvents, {
          eventType: "organization.scim_mapping_changed",
          outcome: "succeeded",
          principalId: actor.value,
          organizationId: organization.id,
          correlationId: c.get("correlationId"),
          targetType: "scim_group_mapping",
          targetId: groupId,
          metadata: { action: "organization.scim_mapping.put", role },
        });
        return c.json({
          organizationId: organization.id,
          groupId,
          role,
        });
      },
    ),
);

scimMappingAdminRoutes.delete(
  "/:organizationId/scim/mappings/:groupId",
  requirePrincipal(),
  async (c) =>
    asActiveOrgOwner(
      c,
      OWNER,
      async ({ ctx, org, proof, actor, organization }) => {
        const groupId = decodeURIComponent(c.req.param("groupId") ?? "");
        // Deleting a neutral mapping is a reduction, so legacy ids qualify.
        if (!groupId) return c.json({ error: "validation_error" }, 400);
        const result = await removeNeutralGroupRoleMapping(
          ctx,
          org,
          proof,
          groupId,
        );
        if (result === "not_found") return c.json({ error: "not_found" }, 404);
        if (result === "mapping_not_neutral")
          return c.json({ error: "mapping_not_neutral" }, 409);
        await appendAuditEvent(ctx.repos.auditEvents, {
          eventType: "organization.scim_mapping_removed",
          outcome: "succeeded",
          principalId: actor.value,
          organizationId: organization.id,
          correlationId: c.get("correlationId"),
          targetType: "scim_group_mapping",
          targetId: groupId,
          metadata: { action: "organization.scim_mapping.remove" },
        });
        return c.body(null, 204);
      },
    ),
);

/**
 * Checks that precede a mapping change: an over-long legacy group id may only
 * keep or lower its mapping, an over-capacity group must shrink first, and a
 * mapping change is charged by the members it will reconcile.
 */
async function mappingRefusal(
  ctx: AppContext,
  organizationId: string,
  groupId: string,
  role: OrganizationRole,
): Promise<
  | {
      status: 400 | 409 | 429;
      error: "validation_error" | "group_requires_reduction" | "rate_limited";
    }
  | undefined
> {
  const current = await ctx.stores.scim.mappings.get(organizationId, groupId);
  if (!scimMappingAdmissible(groupId, role, current))
    return { status: 400, error: "validation_error" };
  const group = await ctx.stores.scim.groups.getById(organizationId, groupId);
  if (group && group.memberIds.length > SCIM_GROUP_MEMBERS_MAX)
    return { status: 409, error: "group_requires_reduction" };
  const cost = Math.max(1, Math.ceil((group?.memberIds.length ?? 0) / 10));
  if (
    !(await consumeScimMutation(ctx, organizationId, undefined, cost, "admin"))
  )
    return { status: 429, error: "rate_limited" };
  return undefined;
}
