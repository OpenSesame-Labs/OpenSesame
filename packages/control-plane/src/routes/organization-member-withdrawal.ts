import {
  ChangeOrganizationMemberRoleRequestSchema,
  OrganizationMembershipResponseSchema,
} from "@opensesame/contracts";
import type { OrganizationRole } from "@opensesame/os-domain";
import { type Context, Hono } from "hono";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { orgOwner } from "../proofs/org-owner.js";
import { withScimOrganizationBoundary } from "../repos/scim-organization-boundary.js";
import {
  prepareOwnerRemovalWithdrawal,
  prepareOwnerRoleWithdrawal,
} from "../services/org-admin.js";
import { finishOrganizationWithdrawal } from "../services/organization-withdrawal.js";
import { type OrgOwnerSource, asOrgOwner } from "./org-owner-gate.js";

const MEMBER_ADMIN: OrgOwnerSource = { param: "id", liveness: "unchecked" };
export const organizationMemberWithdrawalRoutes = new Hono<{
  Variables: Variables;
}>();

async function withdraw(
  c: Context<{ Variables: Variables }>,
  request: { kind: "remove" } | { kind: "change_role"; role: OrganizationRole },
): Promise<Response> {
  return asOrgOwner(c, MEMBER_ADMIN, async ({ ctx, actor, org }) => {
    const prepared = await withScimOrganizationBoundary(
      ctx,
      org.value,
      async (tx) => {
        // Recheck inside the same cross-replica boundary that records the intent.
        const owner = await orgOwner(
          tx.stores,
          actor,
          org,
          MEMBER_ADMIN.liveness,
        );
        if (!owner.ok) return { status: "unauthorized" as const, owner };
        const input = {
        principalId: c.req.param("principalId") ?? "",
          actorPrincipalId: actor.value,
          actorType: "human" as const,
          correlationId: c.get("correlationId"),
        };
        return request.kind === "remove"
          ? prepareOwnerRemovalWithdrawal(tx, org, owner.proof, {
              ...input,
              reason: "organization_owner_removed",
            })
          : prepareOwnerRoleWithdrawal(tx, org, owner.proof, {
              ...input,
              role: request.role,
            });
      },
    );
    if (prepared.status === "unauthorized")
      return c.json({ error: prepared.owner.error }, prepared.owner.status);
    if (prepared.status === "missing")
      return c.json({ error: "membership_not_found" }, 404);
    if (prepared.status === "last_owner")
      return c.json({ error: "last_owner" }, 409);
    if (prepared.status === "busy")
      return c.json(
        {
          error: "membership_change_in_progress",
          message: "Retry the membership change shortly.",
        },
        409,
      );
    if (prepared.status === "unchanged")
      return c.json(
        OrganizationMembershipResponseSchema.parse({
          ...prepared.membership,
          createdAt: prepared.membership.createdAt.toISOString(),
          updatedAt: prepared.membership.updatedAt.toISOString(),
        }),
      );

    const result = await finishOrganizationWithdrawal(ctx, prepared.prepared);
    if (result.status === "pending")
      return c.json(
        {
          error: "session_revocation_failed",
          message: "Retry this request to finish the membership change.",
        },
        502,
      );
    if (result.status === "stale")
      return c.json(
        {
          error: "membership_changed",
          message: "The membership changed; retry your request.",
        },
        409,
      );
    if (result.status === "removed") return c.body(null, 204);
    return c.json(
      OrganizationMembershipResponseSchema.parse({
        ...result.membership,
        createdAt: result.membership.createdAt.toISOString(),
        updatedAt: result.membership.updatedAt.toISOString(),
      }),
    );
  });
}

organizationMemberWithdrawalRoutes.patch(
  "/:id/members/:principalId",
  requirePrincipal(),
  async (c) => {
    const parsed = ChangeOrganizationMemberRoleRequestSchema.safeParse(
      await c.req.json(),
    );
    if (!parsed.success)
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    return withdraw(c, { kind: "change_role", role: parsed.data.role });
  },
);

organizationMemberWithdrawalRoutes.delete(
  "/:id/members/:principalId",
  requirePrincipal(),
  (c) => withdraw(c, { kind: "remove" }),
);
