import { LinkIdentityResponseSchema } from "@opensesame/contracts";
import type { ExternalIdentity } from "@opensesame/os-domain";
import { isString } from "@opensesame/os-domain";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { decodeJwt } from "jose";
import type { AppContext } from "../context.js";
import { normalizeIssuer } from "../interactions/issuer-normalization.js";
import { resolveTrustedIssuer } from "../interactions/trust.js";
import { resolveProvisionalSession } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { revokeSessionTokens } from "../repos/session-storage.js";
import { emailLinkFields } from "../services/email-authority.js";
import { attachVerifiedExternalIdentity } from "../services/identity-link.js";
import {
  type FederatedSessionAdoption,
  ProvisionalCapacityError,
  adoptSessionWithinCapacity,
} from "./federated-session.js";
import {
  OrgAssertionError,
  originAudiences,
  verifyOrgIdToken,
} from "./org-assertion.js";
import { ensurePersonalOnAuthenticatedSession } from "./projects.js";

type LinkContext = Context<{ Variables: Variables }>;
type VerifiedToken = Awaited<ReturnType<typeof verifyOrgIdToken>>;

function issuerKey(issuer: string): string {
  return normalizeIssuer(issuer);
}

const UNTRUSTED_ISSUER = {
  error: "untrusted_issuer",
  message: "That identity issuer is not in the allowlist.",
} as const;

function identitySummary(identity: ExternalIdentity) {
  return {
    id: identity.id,
    kind: identity.kind,
    issuer: identity.issuer,
    subject: identity.subject,
    ...(identity.displayHint !== undefined
      ? { displayHint: identity.displayHint }
      : undefined),
    assurance: identity.assurance,
    linkedAt: identity.linkedAt.toISOString(),
  };
}

/** Bind the browser cookie to a rebound session's token. */
function setSessionCookie(c: LinkContext, ctx: AppContext, token: string) {
  setCookie(c, ctx.config.provisionalCookieName, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(ctx.config.provisionalTtlMs / 1000),
    secure: ctx.config.publicUrl.startsWith("https://"),
  });
}

/** Decode `iss` and allowlist it: the token's issuer, or the refusal. */
function tokenIssuer(c: LinkContext, ctx: AppContext, idToken: string) {
  let rawIssuer = "";
  let issuer = "";
  try {
    const claims = decodeJwt(idToken);
    rawIssuer = isString(claims.iss) ? claims.iss : "";
    issuer = rawIssuer ? issuerKey(rawIssuer) : "";
  } catch {
    return {
      refusal: c.json({ error: "invalid_token", message: "Not a JWT." }, 400),
    };
  }
  const trusted = ctx.config.trustedUpstreamIssuers.map(issuerKey);
  if (!issuer || !trusted.includes(issuer)) {
    return { refusal: c.json(UNTRUSTED_ISSUER, 403) };
  }
  return { rawIssuer, issuer };
}

/** Verify the token against its issuer: the claims, or the refusal. */
async function verifyToken(
  c: LinkContext,
  ctx: AppContext,
  idToken: string,
  rawIssuer: string,
): Promise<{ verified: VerifiedToken } | { refusal: Response }> {
  try {
    // The allowlist is compared normalized, but jose compares `iss` exactly.
    // Hand it the token's own spelling (a trailing slash is legal in an
    // issuer identifier) or a valid token from that issuer is refused.
    const verified = await verifyOrgIdToken(idToken, rawIssuer, {
      expectedAudiences: originAudiences(ctx.config),
      blockPrivateIssuerHosts: ctx.config.isProduction,
    });
    return { verified };
  } catch (error) {
    if (error instanceof OrgAssertionError) {
      const status = error.code === "upstream_unavailable" ? 502 : 401;
      return {
        refusal: c.json({ error: error.code, message: error.message }, status),
      };
    }
    throw error;
  }
}

/** A caller with nothing of their own to merge from. */
function isThrowaway(
  caller: { state: string; assurance: string } | undefined | null,
): boolean {
  return caller?.state === "provisional" || caller?.assurance === "provisional";
}

/**
 * End the session that authenticated this link once its replacement is
 * bound. The presented session predates the adoption in this handler, so
 * revoking it can never name the rebound one; leaving it would strand a
 * live throwaway row (unreachable once its cookie is overwritten, but
 * still counted against the provisional ceiling).
 */
async function revokePresentedSession(c: LinkContext, ctx: AppContext) {
  const sessionIds = new Set<string>();
  const authenticated = c.get("provisionalSessionId");
  if (authenticated) sessionIds.add(authenticated);
  // Bearer [REDACTED] in the auth middleware, so a request can carry a cookie
  // session the middleware never resolved. The adoption overwrote that
  // cookie; its distinct server row must end too, not linger live until
  // expiry as an orphan nobody holds.
  const cookie = getCookie(c, ctx.config.provisionalCookieName);
  if (cookie) {
    const resolved = await resolveProvisionalSession(ctx, cookie);
    if (resolved) sessionIds.add(resolved.sessionId);
  }
  for (const sessionId of sessionIds) {
    const presented = await ctx.stores.provisionalSessions.get(sessionId);
    if (!presented || presented.revokedAt) continue;
    await ctx.stores.provisionalSessions.set(sessionId, {
      ...presented,
      revokedAt: ctx.clock(),
    });
    await revokeSessionTokens(ctx.stores, sessionId);
  }
}

/**
 * A verified token for a subject another principal already owns is a
 * sign-in to that principal when the caller is a throwaway provisional
 * (nothing to merge from): rebind, exactly as the hosted leg does on a
 * tuple hit. A registered caller's collision still needs dual auth, and
 * gets the plain 409 (null here).
 */
async function collisionRebind(
  c: LinkContext,
  ctx: AppContext,
  principalId: string,
  issuer: string,
  verified: VerifiedToken,
): Promise<Response | null> {
  const existing = await ctx.repos.externalIdentities.findByTuple({
    kind: "oidc",
    issuer,
    subject: verified.sub,
  });
  const caller = await ctx.repos.principals.getById(principalId);
  if (!existing || !isThrowaway(caller)) return null;
  // The hosted leg refuses a non-active principal at exchange; a rebind
  // must not hand a suspended or closed principal a fresh session either.
  const owner = await ctx.repos.principals.getById(existing.principalId);
  if (owner?.state !== "active") return null;
  const adoption = await adoptSessionWithinCapacity(
    ctx,
    existing.principalId,
    c.get("correlationId"),
  );
  setSessionCookie(c, ctx, adoption.accessToken);
  await revokePresentedSession(c, ctx);
  return c.json(
    LinkIdentityResponseSchema.parse({
      principalId: existing.principalId,
      identity: identitySummary(existing),
      accessToken: adoption.accessToken,
      expiresAt: adoption.expiresAt,
    }),
  );
}

/**
 * The verified-email join landed the identity on a different principal:
 * adopt a session for that owner, but only while they are active — anyone
 * else keeps the session they arrived with.
 */
async function adoptJoinedIdentity(
  c: LinkContext,
  ctx: AppContext,
  principalId: string,
  identity: ExternalIdentity,
): Promise<FederatedSessionAdoption | undefined> {
  if (identity.principalId === principalId) return undefined;
  // A registered caller is never silently switched onto another principal
  // by an email match: rebinding is for the throwaway minted for this
  // sign-in, exactly as the collision road fences it. A real account's
  // join is a merge, and merging takes dual authentication.
  const caller = await ctx.repos.principals.getById(principalId);
  if (!isThrowaway(caller)) return undefined;
  const owner = await ctx.repos.principals.getById(identity.principalId);
  if (owner?.state !== "active") return undefined;
  return adoptSessionWithinCapacity(
    ctx,
    identity.principalId,
    c.get("correlationId"),
  );
}

/**
 * ADR 0033 production path: decode `iss`, allowlist it, verify the token, then
 * hand the verified subject to the shared identity-link service. Storage,
 * promotion and audit all live in that service so the hosted relying-party leg
 * behaves identically.
 */
export async function linkFromVerifiedIdToken(
  c: LinkContext,
  principalId: string,
  idToken: string,
) {
  const ctx = c.get("ctx");
  const issued = tokenIssuer(c, ctx, idToken);
  if ("refusal" in issued) return issued.refusal;
  const { rawIssuer, issuer } = issued;

  const checked = await verifyToken(c, ctx, idToken, rawIssuer);
  if ("refusal" in checked) return checked.refusal;
  const { verified } = checked;

  /*
   * Email may join accounts (ADR 0057 D15), but only when the issuer that
   * asserted it has the standing to. Passing the allowlist above says this
   * deployment federates to the issuer; it does not say the issuer verifies
   * the addresses it claims. An issuer that hands out `email_verified: true`
   * for anything typed into a profile would otherwise be a way onto whichever
   * principal already owns the address.
   */
  const trust = await resolveTrustedIssuer(ctx, issuer);
  if (!trust) return c.json(UNTRUSTED_ISSUER, 403);
  // The throwaway fence sits BEFORE the attach, not only around the
  // session adoption after it: attach itself performs the D15 email
  // join, so a durable caller would otherwise have their verified
  // identity silently merged onto the principal that owns the address
  // even though their session never switched.
  const caller = await ctx.repos.principals.getById(principalId);
  const result = await attachVerifiedExternalIdentity(ctx, principalId, {
    joinByVerifiedEmail: isThrowaway(caller),
    issuer,
    subject: verified.sub,
    correlationId: c.get("correlationId"),
    ...(verified.name !== undefined
      ? { displayHint: verified.name }
      : undefined),
    ...(await emailLinkFields(
      ctx,
      trust,
      verified.email,
      verified.emailVerified,
    )),
  });

  if (!result.ok) {
    if (result.error === "identity_collision") {
      try {
        const rebound = await collisionRebind(
          c,
          ctx,
          principalId,
          issuer,
          verified,
        );
        if (rebound) return rebound;
      } catch (error) {
        if (error instanceof ProvisionalCapacityError)
          return c.json({ error: "provisional_capacity" }, 429);
        throw error;
      }
    }
    return c.json({ error: result.error, message: result.message }, 409);
  }

  const identity = result.identity;
  // The identity landed on a different principal than the caller's session
  // (verified-email join): bind the session to the principal it belongs to,
  // as identity-link's contract requires of callers that just minted. Only
  // an active principal is adopted into; anyone else keeps the session
  // they arrived with.
  let adoption: FederatedSessionAdoption | undefined;
  try {
    adoption = await adoptJoinedIdentity(c, ctx, principalId, identity);
  } catch (error) {
    if (error instanceof ProvisionalCapacityError)
      return c.json({ error: "provisional_capacity" }, 429);
    throw error;
  }
  if (adoption) {
    setSessionCookie(c, ctx, adoption.accessToken);
    await revokePresentedSession(c, ctx);
  } else if (identity.principalId !== principalId) {
    // The join landed elsewhere but no session was adopted. That is a
    // plain link answer only while the owner is still active; a race
    // into suspension must not be reported as a successful sign-in.
    const owner = await ctx.repos.principals.getById(identity.principalId);
    if (owner?.state !== "active") {
      return c.json(
        {
          error: "identity_collision",
          message:
            "External identity already bound to another principal; merge requires dual authentication",
        },
        409,
      );
    }
  }
  const body = LinkIdentityResponseSchema.parse({
    principalId: identity.principalId,
    ...(adoption
      ? { accessToken: adoption.accessToken, expiresAt: adoption.expiresAt }
      : undefined),
    identity: identitySummary(identity),
  });
  if (!result.alreadyLinked) {
    // First authenticated session for this principal (see the dev-seam path).
    // Only on a fresh link: an idempotent re-link is not a first session, and
    // main's pre-refactor code returned before this point in that case.
    await ensurePersonalOnAuthenticatedSession(
      ctx,
      identity.principalId,
      c.get("correlationId"),
    );
  }

  return result.alreadyLinked ? c.json(body) : c.json(body, 201);
}
