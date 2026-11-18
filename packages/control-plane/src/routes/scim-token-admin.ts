import { createHash, randomBytes } from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { mintScimToken, revokeScimToken } from "../services/org-admin.js";
import { asActiveOrgOwner } from "./org-owner-gate.js";

/** Provisioning-token prefix. Shown once, at mint; only the hash is stored. */
export const SCIM_TOKEN_PREFIX = "sct_";

export function scimTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function scimBase(ctx: AppContext, organizationId: string): string {
  return `${ctx.config.publicUrl}/v1/organizations/${encodeURIComponent(
    organizationId,
  )}/scim/v2`;
}

const OWNER = { param: "organizationId" };
export const scimTokenAdminRoutes = new Hono<{ Variables: Variables }>();

scimTokenAdminRoutes.post(
  "/:organizationId/scim/tokens",
  requirePrincipal(),
  async (c) =>
    asActiveOrgOwner(
      c,
      OWNER,
      async ({ ctx, org, proof, actor, organization }) => {
        // This plaintext token is returned once; only its digest is stored.
        const token = `${SCIM_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
        const minted = await mintScimToken(
          ctx,
          org,
          proof,
          scimTokenHash(token),
        );
        await appendAuditEvent(ctx.repos.auditEvents, {
          eventType: "organization.scim_token_minted",
          outcome: "succeeded",
          principalId: actor.value,
          organizationId: organization.id,
          correlationId: c.get("correlationId"),
          targetType: "scim_token",
          targetId: minted.id,
          metadata: { action: "organization.scim_token.mint" },
        });
        return c.json(
          { id: minted.id, token, scimBaseUrl: scimBase(ctx, organization.id) },
          201,
        );
      },
    ),
);

scimTokenAdminRoutes.get(
  "/:organizationId/scim/tokens",
  requirePrincipal(),
  async (c) =>
    asActiveOrgOwner(c, OWNER, async ({ ctx, organization }) => {
      const tokens = await ctx.stores.scim.tokens.list(organization.id);
      return c.json({
        tokens: tokens.map((record) => ({
          id: record.id,
          createdAt: record.createdAt.toISOString(),
          revokedAt: record.revokedAt?.toISOString() ?? null,
        })),
      });
    }),
);

scimTokenAdminRoutes.delete(
  "/:organizationId/scim/tokens/:tokenId",
  requirePrincipal(),
  async (c) =>
    asActiveOrgOwner(
      c,
      OWNER,
      async ({ ctx, org, proof, actor, organization }) => {
        const tokenId = c.req.param("tokenId") ?? "";
        if (!(await revokeScimToken(ctx, org, proof, tokenId))) {
          return c.json({ error: "not_found" }, 404);
        }
        await appendAuditEvent(ctx.repos.auditEvents, {
          eventType: "organization.scim_token_revoked",
          outcome: "succeeded",
          principalId: actor.value,
          organizationId: organization.id,
          correlationId: c.get("correlationId"),
          targetType: "scim_token",
          targetId: tokenId,
          metadata: { action: "organization.scim_token.revoke" },
        });
        return c.body(null, 204);
      },
    ),
);
