import type { HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../context.js";
import type { Variables } from "../middleware/context.js";
import {
  BetterAuthBridgeError,
  principalForBetterAuthSubject,
  upstreamAuthFor,
  verifyMagicLinkToken,
} from "../services/better-auth-bridge.js";
import { chargeMagicLinkBudget } from "../services/magic-link-budget.js";
import {
  magicLinkConfirmationCsp,
  magicLinkConfirmationHtml,
} from "../services/magic-link-confirmation.js";
import {
  MAGIC_STATE,
  consumeMagicLinkExchange,
  issueMagicLinkExchange,
  validMagicChallenge,
} from "../services/magic-link-exchange.js";
import {
  MAGIC_CALLBACK,
  MAGIC_CHALLENGE,
  MAGIC_STATE_KEY,
  approvedMagicCallback,
  openMagicLinkReturn,
} from "../services/magic-link-return.js";

type NodeEnv = { Bindings: HttpBindings };
type AuthRouter = Hono<{ Variables: Variables } & NodeEnv>;

/**
 * The Better Auth mount (C20 / D16 / ADR 0057).
 *
 * Better Auth is here for one job — email magic-link — and this router is the
 * fence that keeps it to that job. Only the sign-in path is forwarded to
 * Better Auth; the confirmation and exchange are our own constrained routes.
 *
 * An allowlist rather than a deny list, for two reasons that are both security
 * properties rather than tidiness:
 *
 *  - Social sign-in must not be reachable (T22). Better Auth's social endpoints
 *    exist whether or not any provider is configured, and its
 *    `toBetterAuthSocialConfig` silently drops providers that have no client
 *    secret — which is every origin-profile broker OpenSesame fronts. A
 *    half-configured social leg that answers 400 today is one dependency bump
 *    away from answering 302, so it does not get to answer at all. The provider
 *    registry owns social.
 *  - Better Auth's own `/magic-link/verify` and `/get-session` answer with its
 *    user record, and its user id must never cross this API boundary (T33).
 *    The verification is performed server-side by the bridge instead, which
 *    reads that record, writes the `better_auth_subjects` mapping, and hands
 *    back a principal id and a first-party bearer.
 *
 * What is left is `POST /v1/auth/sign-in/magic-link`, whose entire response is
 * `{ status: true }` — no user, no id, no answer about whether the address is
 * known to this deployment.
 */

/** The only Better Auth path this deployment serves over HTTP. */
const ALLOWED_BETTER_AUTH_PATHS = new Set(["/sign-in/magic-link"]);

/** Long enough for any token Better Auth mints; short enough not to be a buffer. */
const MAX_TOKEN_LENGTH = 512;
const requestSchema = z.object({
  email: z.string().email().max(254),
  callbackURL: z.string().max(2048).optional(),
  codeChallenge: z.string().max(128).optional(),
  state: z.string().max(128).optional(),
});
const exchangeSchema = z.object({
  code: z.string().max(128),
  codeVerifier: z.string().max(128),
  state: z.string().max(128),
});
const proofSchema = z.object({
  token: z.string().min(1).max(MAX_TOKEN_LENGTH),
  return: z.string().min(1).max(4096),
});

/**
 * The two ways the provisional-mint fence refuses. Both are "come back later",
 * so both answer 429 — the same mapping the interaction login route uses, so a
 * client does not have to learn which surface it is talking to.
 */
const MINT_REFUSALS = new Set(["rate_limited", "provisional_capacity"]);
const UPGRADE_TELEMETRY_WINDOW_MS = 60_000;
let nextUpgradeTelemetryAt = 0;
let suppressedUpgradeEvents = 0;

function recordLegacyClient(ctx: AppContext): void {
  const now = ctx.clock().getTime();
  if (now < nextUpgradeTelemetryAt) {
    suppressedUpgradeEvents += 1;
    return;
  }
  ctx.log.warn(
    {
      event: "magic_link_client_upgrade_required",
      requiredProtocol: "magic-link-pkce-v1",
      suppressedSinceLast: suppressedUpgradeEvents,
    },
    "legacy magic-link request refused",
  );
  suppressedUpgradeEvents = 0;
  nextUpgradeTelemetryAt = now + UPGRADE_TELEMETRY_WINDOW_MS;
}

export function resetMagicLinkUpgradeTelemetryForTest(): void {
  nextUpgradeTelemetryAt = 0;
  suppressedUpgradeEvents = 0;
}

function installMagicLinkRequest(routes: AuthRouter, ctx: AppContext): void {
  routes.post("/sign-in/magic-link", async (c) => {
    const parsed = requestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    const { email, callbackURL, codeChallenge, state } = parsed.data;
    const origin = c.req.header("origin");
    const callback =
      origin && callbackURL
        ? approvedMagicCallback(ctx, callbackURL, origin)
        : undefined;
    if (!callback) return c.json({ error: "invalid_request" }, 400);
    if (!codeChallenge || !state) {
      recordLegacyClient(ctx);
      c.header("cache-control", "no-store");
      return c.json(
        {
          error: "client_upgrade_required",
          requiredProtocol: "magic-link-pkce-v1",
          action: "reload",
        },
        426,
      );
    }
    if (!validMagicChallenge(codeChallenge) || !MAGIC_STATE.test(state))
      return c.json({ error: "invalid_request" }, 400);
    if (
      (await chargeMagicLinkBudget(
        ctx,
        email,
        c.env?.incoming?.socket?.remoteAddress,
      )) !== "ok"
    )
      return c.json({ error: "rate_limited" }, 429);
    const metadata = {
      [MAGIC_CALLBACK]: callback.toString(),
      [MAGIC_CHALLENGE]: codeChallenge,
      [MAGIC_STATE_KEY]: state,
    };
    const headers = new Headers(c.req.raw.headers);
    headers.delete("content-length");
    return upstreamAuthFor(ctx).auth.handler(
      new Request(c.req.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ email, metadata }),
      }),
    );
  });
}

function installMagicLinkConfirmation(
  routes: AuthRouter,
  ctx: AppContext,
): void {
  routes.get("/magic-link/complete", (c) => {
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    c.header("content-security-policy", magicLinkConfirmationCsp(ctx));
    return c.html(magicLinkConfirmationHtml);
  });
  routes.post("/magic-link/complete", async (c) => {
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    const form = await c.req.formData().catch(() => undefined);
    const tokens = form?.getAll("token") ?? [];
    const returns = form?.getAll("return") ?? [];
    const invalid = () =>
      c.json({ error: "invalid_token" } as const, 401 as const);
    if (tokens.length !== 1 || returns.length !== 1) return invalid();
    const proof = proofSchema.safeParse({
      token: tokens[0],
      return: returns[0],
    });
    if (!proof.success) return invalid();
    const { token } = proof.data;
    const continuation = openMagicLinkReturn(ctx, token, proof.data.return);
    if (!continuation) return invalid();
    const subject = await verifyMagicLinkToken(ctx, token);
    if (!subject) return invalid();
    const callback = approvedMagicCallback(ctx, continuation.callback);
    if (!callback) return invalid();
    const code = await issueMagicLinkExchange(
      ctx,
      subject,
      continuation.challenge,
      continuation.state,
      callback.origin,
    );
    callback.searchParams.set("magic_code", code);
    callback.searchParams.set("magic_state", continuation.state);
    return c.redirect(callback.toString(), 303);
  });
}

function installMagicLinkExchange(routes: AuthRouter, ctx: AppContext): void {
  routes.post("/magic-link/exchange", async (c) => {
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    const origin = c.req.header("origin");
    const parsed = exchangeSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!origin || !ctx.config.corsOrigins.includes(origin) || !parsed.success)
      return c.json({ error: "invalid_token" }, 401);
    const { code, codeVerifier, state } = parsed.data;
    const subject = await consumeMagicLinkExchange(
      ctx,
      code,
      codeVerifier,
      state,
      origin,
    );
    if (!subject) return c.json({ error: "invalid_token" }, 401);
    try {
      const session = await principalForBetterAuthSubject(
        ctx,
        subject,
        c.get("correlationId"),
      );
      return c.json(session, 200);
    } catch (error) {
      if (error instanceof BetterAuthBridgeError)
        return c.json(
          { error: error.code, message: error.message },
          MINT_REFUSALS.has(error.code) ? 429 : 403,
        );
      throw error;
    }
  });
}

export function createUpstreamAuthRoutes(
  ctx: AppContext,
): Hono<{ Variables: Variables } & NodeEnv> {
  const routes = new Hono<{ Variables: Variables } & NodeEnv>();
  // The handlers use the `ctx` this router was built with rather than
  // `c.get("ctx")`: the middleware puts the same object on every request, and
  // reading it from the closure is what binds the Better Auth instance and the
  // mailer seam to one control plane.
  //
  // `upstreamAuthFor` is deliberately NOT called here. It is memoized per
  // context, so the mount and the interaction sub-router already share one
  // instance; building it at mount time would only mean every deployment that
  // never sends a magic link still pays for a Better Auth init, and fails at
  // boot on a configuration Better Auth dislikes but this API never consults.

  installMagicLinkRequest(routes, ctx);
  installMagicLinkConfirmation(routes, ctx);
  installMagicLinkExchange(routes, ctx);

  routes.all("/*", async (c) => {
    const url = new URL(c.req.url);
    const path = url.pathname.slice("/v1/auth".length) || "/";
    if (!ALLOWED_BETTER_AUTH_PATHS.has(path)) {
      // 404, not 403: the endpoints this deployment does not serve should not
      // be distinguishable from endpoints that do not exist.
      return c.json({ error: "not_found" }, 404);
    }
    return upstreamAuthFor(ctx).auth.handler(c.req.raw);
  });

  return routes;
}
