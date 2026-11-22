import { randomUUID } from "node:crypto";
import { AddOrganizationMemberRequestSchema } from "@opensesame/contracts";
import { Hono } from "hono";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { activeOrgOwner } from "../proofs/org-owner.js";
import {
  type OrganizationWithdrawalAuditIntent,
  finishOrganizationWithdrawalAudit,
  recordOrganizationWithdrawalAudit,
} from "../repos/organization-withdrawal-audit.js";
import { withScimOrganizationBoundary } from "../repos/scim-organization-boundary.js";
import { writeOrganizationMembership } from "../services/org-admin.js";
import { asActiveOrgOwner } from "./org-owner-gate.js";
import {
  getMembership,
  serializeMembershipMutation,
} from "./organization-membership.js";
import { membershipResponse } from "./organization-membership-response.js";

const MEMBER_ADMIN = { param: "id" };
export const organizationMemberAddRoutes = new Hono<{ Variables: Variables }>();

organizationMemberAddRoutes.post(
  "/:id/members",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const organizationId = c.req.param("id");
    return asActiveOrgOwner(c, MEMBER_ADMIN, async ({ org, actor }) => {
      const outcome = await withScimOrganizationBoundary(
        ctx,
        organizationId,
        (tx) =>
          serializeMembershipMutation(tx, organizationId, async () => {
            const owner = await activeOrgOwner(tx.stores, actor, org);
            if (!owner.ok)
              return { response: c.json({ error: owner.error }, owner.status) };
            const principalId = actor.value;
            const parsed = AddOrganizationMemberRequestSchema.safeParse(
              await c.req.json(),
            );
            if (!parsed.success) {
              return {
                response: c.json(
                  {
                    error: "validation_error",
                    details: parsed.error.flatten(),
                  },
                  400,
                ),
              };
            }
            const principal = await tx.repos.principals.getById(
              parsed.data.principalId,
            );
            if (!principal)
              return {
                response: c.json({ error: "principal_not_found" }, 404),
              };
            if (
              principal.state === "suspended" ||
              principal.state === "closed"
            ) {
              return { response: c.json({ error: "principal_inactive" }, 409) };
            }
            if (await getMembership(tx, organizationId, principal.id)) {
              return { response: c.json({ error: "membership_exists" }, 409) };
            }
            const now = ctx.clock();
            const membership = await writeOrganizationMembership(
              tx,
              org,
              owner.proof,
              {
                organizationId,
                principalId: principal.id,
                role: parsed.data.role,
                createdAt: now,
                updatedAt: now,
              },
            );
            const intent: OrganizationWithdrawalAuditIntent = {
              id: randomUUID(),
              kind: "add",
              actorPrincipalId: principalId,
              actorType: "human",
              organizationId,
              principalId: principal.id,
              correlationId: c.get("correlationId"),
              role: membership.role,
            };
            await recordOrganizationWithdrawalAudit(tx, intent);
            return { membership, intent };
          }),
      );
      if ("response" in outcome) return outcome.response;
      await finishOrganizationWithdrawalAudit(ctx, outcome.intent);
      return c.json(membershipResponse(outcome.membership), 201);
    });
  },
);
