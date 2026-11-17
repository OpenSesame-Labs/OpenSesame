import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AppContext } from "../context.js";
import { boundCookieMatches } from "./bound-cookie.js";
import { boundCookieName, validBoundSessionId } from "./bound-cookie-name.js";
import type { Variables } from "./context.js";

/**
 * Resolve principal from Bearer token or provisional cookie.
 * Only `pst_…` access tokens authenticate; session ids (`ps_…`) never do.
 * `Authorization: Bearer prn_…` is opt-in for local tests only
 * (`OPENSESAME_ALLOW_PRINCIPAL_BEARER=true`, never in production).
 */
async function principalStillAuthenticates(
  ctx: AppContext,
  principalId: string,
): Promise<boolean> {
  const principal = await ctx.repos.principals.getById(principalId);
  // A session is a lease on a principal, not a copy of it. Suspension or
  // closure must take effect on the next request, not when the lease expires.
  return (
    principal !== null &&
    principal !== undefined &&
    principal.state !== "suspended" &&
    principal.state !== "closed" &&
    !(await ctx.stores.organizationMemberships.hasPendingWithdrawalForPrincipal(
      principalId,
    ))
  );
}

export async function resolveProvisionalSession(
  ctx: AppContext,
  token: string,
): Promise<{ principalId: string; sessionId: string } | undefined> {
  if (!token.startsWith("pst_")) return undefined;
  const sessionId = await ctx.stores.provisionalTokens.get(token);
  if (!sessionId) return undefined;
  const session = await ctx.stores.provisionalSessions.get(sessionId);
  if (
    !session ||
    session.expiresAt <= ctx.clock() ||
    session.revokedAt ||
    session.revocationCleanupPending
  ) {
    return undefined;
  }
  if (!(await principalStillAuthenticates(ctx, session.principalId))) {
    return undefined;
  }
  return { principalId: session.principalId, sessionId: session.id };
}

/** Methods that only read. A forged read is not a forged write. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Whether an ambient cookie may authenticate this request.
 *
 * A cookie is sent by the browser whether or not the page meant to send it, so on
 * its own it says nothing about who asked. `SameSite=Lax` stops the obvious
 * cross-site form post, but it is a browser default, it does not separate
 * sibling origins on the same site, and it is not a rule this service enforces.
 *
 * So a mutation authenticated by cookie must also carry an `Origin` this
 * deployment listed, or the service's own origin. A bearer token is unaffected:
 * a caller that had to attach a token was not tricked into attaching it.
 */
export function cookieAuthAllowed(
  ctx: AppContext,
  method: string,
  origin: string | undefined,
): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return true;
  if (!origin) return false;
  if (ctx.config.corsOrigins.includes(origin)) return true;
  try {
    return new URL(ctx.config.publicUrl).origin === origin;
  } catch {
    return false;
  }
}

function validExpectedPrincipal(value: string | undefined): value is string {
  return Boolean(value && value.length <= 200);
}

async function resolveBoundRequest(c: Context<{ Variables: Variables }>) {
  const ctx = c.get("ctx");
  const boundId = c.req.header("x-opensesame-session-id");
  const proof = c.req.header("x-opensesame-session-proof");
  const expected = c.req.header("x-opensesame-principal-id");
  if (boundId === undefined && proof === undefined && expected === undefined)
    return "none" as const;
  const cookie =
    boundId && validBoundSessionId(boundId)
      ? getCookie(c, boundCookieName(ctx.config.provisionalCookieName, boundId))
      : undefined;
  if (
    !boundId ||
    !proof ||
    !validExpectedPrincipal(expected) ||
    !cookie ||
    !cookieAuthAllowed(ctx, c.req.method, c.req.header("origin"))
  )
    return "invalid" as const;
  const resolved = await resolveProvisionalSession(ctx, cookie);
  if (
    !resolved ||
    resolved.sessionId !== boundId ||
    resolved.principalId !== expected ||
    !(await boundCookieMatches(ctx, boundId, proof))
  )
    return "invalid" as const;
  return resolved;
}

export function authMiddleware() {
  return createMiddleware<{ Variables: Variables }>(async (c, next) => {
    const ctx = c.get("ctx");
    const cookieName = ctx.config.provisionalCookieName;

    // Bound-cookie callers require this exact session on every request. Never
    // fall back to another tab's cookie when the supplied proof does not fit.
    const bound = await resolveBoundRequest(c);
    if (bound !== "none") {
      if (bound === "invalid") return c.json({ error: "unauthorized" }, 401);
      c.set("principalId", bound.principalId);
      c.set("provisionalSessionId", bound.sessionId);
      c.header("X-OpenSesame-Cookie-Bound", "1");
      await next();
      return;
    }

    const auth = c.req.header("authorization");
    if (auth?.toLowerCase().startsWith("bearer ")) {
      const token = auth.slice(7).trim();
      const resolved = await resolveProvisionalSession(ctx, token);
      if (resolved) {
        c.set("principalId", resolved.principalId);
        c.set("provisionalSessionId", resolved.sessionId);
        await next();
        return;
      }
      if (ctx.config.allowPrincipalBearer && token.startsWith("prn_")) {
        if (await principalStillAuthenticates(ctx, token)) {
          c.set("principalId", token);
          await next();
          return;
        }
      }
      // A client requiring a principal bearer cannot fall back to a cookie.
      if (c.req.header("x-opensesame-require-bearer") === "1")
        return c.json({ error: "unauthorized" }, 401);
    }

    const cookieVal = getCookie(c, cookieName);
    if (
      cookieVal &&
      cookieAuthAllowed(ctx, c.req.method, c.req.header("origin"))
    ) {
      const resolved = await resolveProvisionalSession(ctx, cookieVal);
      if (resolved) {
        c.set("principalId", resolved.principalId);
        c.set("provisionalSessionId", resolved.sessionId);
      }
    }

    await next();
  });
}

export function requirePrincipal() {
  return createMiddleware<{ Variables: Variables }>(async (c, next) => {
    if (!c.get("principalId")) {
      return c.json(
        { error: "unauthorized", message: "Authentication required" },
        401,
      );
    }
    await next();
  });
}
