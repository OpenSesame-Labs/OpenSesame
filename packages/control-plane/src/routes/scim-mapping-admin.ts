import { appendAuditEvent } from "@opensesame/audit";
import {
  SCIM_GROUP_ID_MAX,
  SCIM_GROUP_MEMBERS_MAX,
  ScimAdminCapacityError,
} from "@opensesame/database";
import { isString, overlapCast } from "@opensesame/os-domain";
import { Hono } from "hono";
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
      async ({ ctx, org, proof, actor, organization }) => {
        const groupId = decodeURIComponent(c.req.param("groupId") ?? "");
        const body = overlapCast(await c.req.json().catch(() => ({})));
        const role = isString(body.role) ? body.role : "";
        if (
          !groupId ||
          groupId.length > SCIM_GROUP_ID_MAX ||
          (role !== "owner" && role !== "admin" && role !== "member")
        ) {
          return c.json({ error: "validation_error" }, 400);
        }
        const group = await ctx.stores.scim.groups.getById(
          organization.id,
          groupId,
        );
        if (group && group.memberIds.length > SCIM_GROUP_MEMBERS_MAX)
          return c.json({ error: "group_requires_reduction" }, 409);
        const cost = Math.max(
          1,
          Math.ceil((group?.memberIds.length ?? 0) / 10),
        );
        if (
          !(await consumeScimMutation(
            ctx,
            organization.id,
            undefined,
            cost,
            "admin",
          ))
        ) {
          c.header("Retry-After", "60");
          return c.json({ error: "rate_limited" }, 429);
        }
        try {
          await putGroupRoleMapping(ctx, org, proof, groupId, role);
        } catch (error) {
          if (error instanceof ScimAdminCapacityError)
            return c.json({ error: "scim_mapping_capacity" }, 409);
          throw error;
        }
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
        if (!groupId || groupId.length > SCIM_GROUP_ID_MAX)
          return c.json({ error: "validation_error" }, 400);
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
