import type { Context } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import {
  boundCookieName,
  boundCookiePath,
  boundCookieSameSite,
} from "./bound-cookie-name.js";
import type { Variables } from "./context.js";

/** Dispatch under a verified cookie without ever returning it to JavaScript. */
export async function boundCookieProxy(
  c: Context<{ Variables: Variables }>,
  dispatch: (request: Request) => Response | Promise<Response>,
): Promise<Response> {
  const sessionId = c.req.header("x-opensesame-session-id");
  if (
    !c.get("principalId") ||
    !sessionId ||
    !c.req.header("x-opensesame-session-proof")
  )
    return c.json({ error: "unauthorized" }, 401);
  const cookieName = boundCookieName(
    c.get("ctx").config.provisionalCookieName,
    sessionId,
  );
  const cookie = getCookie(c, cookieName);
  if (!cookie) return c.json({ error: "unauthorized" }, 401);
  const url = new URL(c.req.url);
  const suffix = url.pathname.slice("/v1/bound/".length);
  if (!suffix || suffix === "bound" || suffix.startsWith("bound/"))
    return c.json({ error: "not_found" }, 404);
  url.pathname = `/v1/${suffix}`;
  const request = new Request(url, c.req.raw);
  request.headers.delete("cookie");
  request.headers.delete("x-opensesame-session-id");
  request.headers.delete("x-opensesame-session-proof");
  request.headers.delete("x-opensesame-principal-id");
  request.headers.set("authorization", `Bearer ${cookie}`);
  request.headers.set("x-opensesame-require-bearer", "1");
  const response = await dispatch(request);
  const headers = new Headers(response.headers);
  headers.set("X-OpenSesame-Cookie-Bound", "1");
  const replaced =
    suffix === "principals/link-identities" &&
    response.ok &&
    (response.headers.get("set-cookie") ?? "").includes(
      `${c.get("ctx").config.provisionalCookieName}_bound_`,
    );
  if ((suffix === "principals/provisional/revoke" || replaced) && response.ok) {
    deleteCookie(c, cookieName, {
      httpOnly: true,
      sameSite: boundCookieSameSite(c.get("ctx").config.publicUrl),
      path: boundCookiePath(c.get("ctx").config.publicUrl),
      secure: c.get("ctx").config.publicUrl.startsWith("https://"),
    });
    const cleared = c.res.headers.get("set-cookie");
    if (cleared) headers.append("set-cookie", cleared);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
