import type { Context } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { z } from "zod";
import { revokeProvisionalSession } from "../repos/provisional-revocation.js";
import { cookieAuthAllowed, resolveProvisionalSession } from "./auth.js";
import {
  boundCookieName,
  boundCookiePath,
  boundCookieSameSite,
  validBoundSessionId,
} from "./bound-cookie-name.js";
import type { Variables } from "./context.js";

type C = Context<{ Variables: Variables }>;
type LiveCookieSlots = { sessions: string[]; more: boolean };
const proofSchema = z.object({
  restoreProofHash: z.string().regex(/^[0-9a-f]{64}$/u),
});
const exitSchema = z.object({ sessionId: z.string() });

async function liveSlots(c: C): Promise<LiveCookieSlots> {
  const ctx = c.get("ctx");
  const prefix = `${ctx.config.provisionalCookieName}_bound_`;
  const result: string[] = [];
  const candidates = Object.entries(getCookie(c)).filter(
    ([name]) =>
      name.startsWith(prefix) && validBoundSessionId(name.slice(prefix.length)),
  );
  for (const [name, token] of candidates.slice(0, 64)) {
    const id = name.slice(prefix.length);
    const resolved = await resolveProvisionalSession(ctx, token);
    if (resolved?.sessionId === id) result.push(id);
    else
      deleteCookie(c, name, {
        httpOnly: true,
        sameSite: boundCookieSameSite(ctx.config.publicUrl),
        path: boundCookiePath(ctx.config.publicUrl),
        secure: ctx.config.publicUrl.startsWith("https://"),
      });
  }
  return { sessions: result, more: candidates.length > 64 };
}

export async function boundCookieStatus(c: C): Promise<Response> {
  c.header("Cache-Control", "no-store");
  const { sessions, more } = await liveSlots(c);
  return more ? c.json({ sessions, more: true }) : c.json({ sessions });
}

/** Mint only through a route that old replicas cannot mistake for a normal mint. */
export async function boundCookieMint(
  c: C,
  dispatch: (request: Request) => Response | Promise<Response>,
): Promise<Response> {
  const ctx = c.get("ctx");
  if (!cookieAuthAllowed(ctx, c.req.method, c.req.header("origin")))
    return c.json({ error: "forbidden" }, 403);
  const slots = await liveSlots(c);
  if (slots.more || slots.sessions.length > 0)
    return c.json({ error: "session_exists" }, 409);
  const legacy = getCookie(c, ctx.config.provisionalCookieName);
  if (legacy && (await resolveProvisionalSession(ctx, legacy)))
    return c.json({ error: "session_exists" }, 409);
  const raw = await c.req.text();
  try {
    if (!proofSchema.safeParse(JSON.parse(raw)).success)
      return c.json({ error: "invalid_request" }, 400);
  } catch {
    return c.json({ error: "invalid_request" }, 400);
  }
  const url = new URL(c.req.url);
  url.pathname = "/v1/principals/provisional";
  const headers = new Headers(c.req.raw.headers);
  headers.delete("cookie");
  headers.delete("authorization");
  const response = await dispatch(
    new Request(url, { method: "POST", headers, body: raw }),
  );
  const resultHeaders = new Headers(response.headers);
  resultHeaders.set("X-OpenSesame-Cookie-Bound", "1");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: resultHeaders,
  });
}

export async function boundCookieExit(c: C): Promise<Response> {
  const ctx = c.get("ctx");
  if (!cookieAuthAllowed(ctx, c.req.method, c.req.header("origin")))
    return c.json({ error: "forbidden" }, 403);
  let id: string;
  try {
    const parsed = exitSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    id = parsed.data.sessionId;
  } catch {
    return c.json({ error: "invalid_request" }, 400);
  }
  if (!validBoundSessionId(id))
    return c.json({ error: "invalid_request" }, 400);
  const name = boundCookieName(ctx.config.provisionalCookieName, id);
  const cookie = getCookie(c, name);
  const resolved = cookie
    ? await resolveProvisionalSession(ctx, cookie)
    : undefined;
  if (!resolved || resolved.sessionId !== id)
    return c.json({ error: "session_changed" }, 409);
  const session = await revokeProvisionalSession(ctx, id, {
    actorType: "human",
    correlationId: c.get("correlationId"),
    metadata: { action: "principal.provisional_revoke" },
  });
  if (!session) return c.json({ error: "session_changed" }, 409);
  deleteCookie(c, name, {
    httpOnly: true,
    sameSite: boundCookieSameSite(ctx.config.publicUrl),
    path: boundCookiePath(ctx.config.publicUrl),
    secure: ctx.config.publicUrl.startsWith("https://"),
  });
  return c.body(null, 204);
}
