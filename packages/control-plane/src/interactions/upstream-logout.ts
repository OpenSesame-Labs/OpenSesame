import { appendAuditEvent } from "@opensesame/audit";
import type { AppContext } from "../context.js";
import {
  advancePrincipalSessionEpoch,
  advancePrincipalSessionEpochOn,
  withPrincipalSessionBoundary,
} from "../repos/principal-session-boundary.js";
import { revokeSessionTokens } from "../repos/session-storage.js";

const REVOCABLE_IDENTITY_KINDS = [
  "oidc",
  "oauth2",
  "saml",
  "ldap",
  "email",
] as const;

/**
 * Revoke every live provisional session belonging to the principals linked to
 * `(issuer, subject)`; returns how many sessions ended (C17).
 *
 * This is the effect half of OIDC Back-Channel Logout (S10 owns the endpoint
 * that verifies the `logout_token`). It deliberately takes an issuer and a
 * subject rather than a principal id: the caller is holding an upstream
 * assertion, and resolving it to principals here keeps the tuple lookup — the
 * one binding that matters — in one place.
 */
export async function revokeSessionsForIdentity(
  ctx: AppContext,
  issuer: string,
  subject: string,
  tenant?: string,
): Promise<number> {
  const principalIds = new Set<string>();
  for (const kind of REVOCABLE_IDENTITY_KINDS) {
    for (const namespace of tenant ? [undefined, tenant] : [undefined]) {
      const identity = await ctx.repos.externalIdentities.findByTuple({
        kind,
        issuer,
        subject,
        ...(namespace ? { tenant: namespace } : undefined),
      });
      if (identity) principalIds.add(identity.principalId);
    }
  }
  if (principalIds.size === 0) return 0;

  let revoked = 0;
  for (const principalId of principalIds) {
    const revokedSessions = await withPrincipalSessionBoundary(
      ctx.stores,
      principalId,
      "revoke",
      async (stores, database) => {
        if (database)
          await advancePrincipalSessionEpochOn(database, principalId);
        else await advancePrincipalSessionEpoch(stores, principalId);
        const sessionIds: string[] = [];
        const now = ctx.clock();
        for (const [, session] of await stores.provisionalSessions.entries()) {
          if (session.principalId !== principalId || session.revokedAt) continue;
          await stores.provisionalSessions.set(session.id, {
            ...session,
            revokedAt: now,
          });
          await revokeSessionTokens(stores, session.id);
          sessionIds.push(session.id);
        }
        return sessionIds;
      },
    );
    revoked += revokedSessions.length;
    for (const sessionId of revokedSessions)
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "principal.provisional_revoked",
        outcome: "succeeded",
        principalId,
        sessionId,
        correlationId: `upstream-logout-${sessionId}`,
        actorType: "system",
        metadata: {
          action: "principal.provisional_revoke",
          issuer,
          via: "upstream_logout",
        },
      });
  }
  return revoked;
}
