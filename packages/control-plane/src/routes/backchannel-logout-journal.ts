import { createHash } from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import type { AppContext } from "../context.js";
import {
  completeUpstreamLogoutOperation,
  sessionIdsForIdentity,
} from "../interactions/federated.js";
import type { TrustResolution } from "../interactions/trust.js";
import { updateSecurityMap } from "../repos/durable-map.js";

/** OIDC Back-Channel Logout 1.0 §2.6 requires a recent `iat`. */
export const LOGOUT_TOKEN_MAX_AGE_SECONDS = 120;

export type VerifiedLogoutToken = { subject?: string; sessionId?: string };

type VerifiedLogout = {
  issuer: string;
  resolution: TrustResolution;
  claims: VerifiedLogoutToken;
  token: string;
  correlationId: string;
};

async function claimLogout(
  ctx: AppContext,
  callbackDigest: string,
): Promise<boolean> {
  const seenAt = ctx.clock();
  return ctx.repos.callbackReplays.claim({
    id: `oidc-logout:${callbackDigest}`,
    providerId: "oidc-logout",
    callbackDigest,
    seenAt,
    expiresAt: new Date(
      seenAt.getTime() + (LOGOUT_TOKEN_MAX_AGE_SECONDS + 10) * 1000,
    ),
  });
}

async function prepareLogout(
  ctx: AppContext,
  input: VerifiedLogout,
  subject: string,
  operationKey: string,
) {
  const proposed = await sessionIdsForIdentity(
    ctx,
    input.issuer,
    subject,
    input.resolution.source === "org"
      ? input.resolution.organizationId
      : undefined,
  );
  return updateSecurityMap(
    ctx.stores.upstreamLogoutOperations,
    operationKey,
    (current) =>
      current ?? {
        operationKey,
        issuer: input.issuer,
        subject,
        sessionIds: proposed,
        sessionsRevoked: proposed.length,
        correlationId: input.correlationId,
        retainUntil:
          ctx.clock().getTime() + (LOGOUT_TOKEN_MAX_AGE_SECONDS + 10) * 1000,
        completed: false,
      },
  );
}

/** Journal and complete a verified upstream logout before returning success. */
export async function completeVerifiedLogout(
  ctx: AppContext,
  input: VerifiedLogout,
): Promise<void> {
  const callbackDigest = createHash("sha256").update(input.token).digest("hex");
  const operationKey = `oidc-logout:${callbackDigest}`;
  const subject = input.claims.subject;
  // Persist the complete revocation set before claiming the replay token, so
  // a retry can resume after a process dies at the replay boundary.
  const operation = subject
    ? await prepareLogout(ctx, input, subject, operationKey)
    : undefined;
  const firstClaim = await claimLogout(ctx, callbackDigest);
  if (subject) {
    if (!operation) throw new Error("Upstream logout journal unavailable");
    if (operation.issuer !== input.issuer || operation.subject !== subject)
      throw new Error("Upstream logout journal conflict");
    if (!operation.completed)
      await completeUpstreamLogoutOperation(ctx, operation);
    return;
  }
  // A sid-only token names no session retained here. It is accepted without
  // revoking anyone, with one audit record for its first replay claim.
  if (!firstClaim) return;
  await appendAuditEvent(ctx.repos.auditEvents, {
    id: `upstream-logout:${callbackDigest}`,
    eventType: "principal.upstream_logout",
    outcome: "succeeded",
    correlationId: input.correlationId,
    actorType: "system",
    actorId: "upstream",
    metadata: {
      action: "principal.upstream_logout",
      issuer: input.issuer,
      via: "backchannel_logout",
      count: 0,
    },
  });
}
