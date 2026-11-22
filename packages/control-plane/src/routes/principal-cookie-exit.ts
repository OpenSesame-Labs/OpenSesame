import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import {
  cookieAuthAllowed,
  resolveProvisionalSession,
} from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { revokeProvisionalSession } from "../repos/provisional-revocation.js";

/** Explicitly end the observed ambient cookie without clearing a newer cookie. */
export const principalCookieExitRoutes = new Hono<{ Variables: Variables }>();

principalCookieExitRoutes.get("/cookie-status", async (c) => {
  const ctx = c.get("ctx");
  const cookie = getCookie(c, ctx.config.provisionalCookieName);
  const session = cookie
    ? await resolveProvisionalSession(ctx, cookie)
    : undefined;
  return session
    ? c.json({ sessionId: session.sessionId })
    : c.json({ error: "unauthorized" }, 401);
});

principalCookieExitRoutes.post("/cookie-sign-out", async (c) => {
  const ctx = c.get("ctx");
  if (!cookieAuthAllowed(ctx, c.req.method, c.req.header("origin")))
    return c.json({ error: "forbidden" }, 403);
  let expected: unknown;
  try {
    const body: unknown = await c.req.json();
    if (body && typeof body === "object" && "sessionId" in body)
      expected = body.sessionId;
  } catch {
    return c.json({ error: "invalid_request" }, 400);
  }
  if (typeof expected !== "string" || !expected || expected.length > 200)
    return c.json({ error: "invalid_request" }, 400);
  const cookie = getCookie(c, ctx.config.provisionalCookieName);
  const resolved = cookie
    ? await resolveProvisionalSession(ctx, cookie)
    : undefined;
  if (!resolved || resolved.sessionId !== expected)
    return c.json({ error: "session_changed" }, 409);
  const session = await revokeProvisionalSession(ctx, expected, {
    actorType: "human",
    correlationId: c.get("correlationId"),
    metadata: { action: "principal.provisional_revoke" },
  });
  if (!session) return c.json({ error: "session_changed" }, 409);
  return c.body(null, 204);
});
