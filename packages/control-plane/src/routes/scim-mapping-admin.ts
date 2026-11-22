import { isString, overlapCast } from "@opensesame/os-domain";
import { Hono } from "hono";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { asActiveOrgOwner } from "./org-owner-gate.js";
import { putGroupRoleMapping } from "./scim-groups.js";

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
      const mappings = await ctx.stores.scim.mappings.listByOrganization(
        organization.id,
      );
      return c.json({ mappings });
    }),
);

scimMappingAdminRoutes.put(
  "/:organizationId/scim/mappings/:groupId",
  requirePrincipal(),
  async (c) =>
    asActiveOrgOwner(c, OWNER, async ({ ctx, org, proof, organization }) => {
      const groupId = decodeURIComponent(c.req.param("groupId") ?? "");
      const body = overlapCast(await c.req.json().catch(() => ({})));
      const role = isString(body.role) ? body.role : "";
      if (
        !groupId ||
        (role !== "owner" && role !== "admin" && role !== "member")
      ) {
        return c.json({ error: "validation_error" }, 400);
      }
      await putGroupRoleMapping(ctx, org, proof, groupId, role);
      return c.json({
        organizationId: organization.id,
        groupId,
        role,
      });
    }),
);
