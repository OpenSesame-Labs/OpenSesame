/** Install proof-bound cookie material for a rebound Identity session. */
import type { Context } from "hono";
import { setCookie } from "hono/cookie";
import type { AppContext } from "../context.js";
import {
  boundCookieName,
  boundCookiePath,
  boundCookieSameSite,
} from "../middleware/bound-cookie-name.js";
import type { Variables } from "../middleware/context.js";
import { updateSecurityMap } from "../repos/durable-map.js";
import { rememberProvisionalProof } from "../repos/session-storage.js";
import type { FederatedSessionAdoption } from "./federated-session.js";

type LinkContext = Context<{ Variables: Variables }>;

/** Bind the browser cookie to a rebound session's token. */
export function setSessionCookie(
  c: LinkContext,
  ctx: AppContext,
  adoption: FederatedSessionAdoption,
) {
  const proof = c.req.header("x-opensesame-next-proof");
  const bound = Boolean(proof && /^[0-9a-f]{64}$/u.test(proof));
  setCookie(
    c,
    bound
      ? boundCookieName(ctx.config.provisionalCookieName, adoption.sessionId)
      : ctx.config.provisionalCookieName,
    adoption.accessToken,
    {
      httpOnly: true,
      sameSite: bound ? boundCookieSameSite(ctx.config.publicUrl) : "Lax",
      path: bound ? boundCookiePath(ctx.config.publicUrl) : "/",
      maxAge: Math.floor(ctx.config.provisionalTtlMs / 1000),
      secure: ctx.config.publicUrl.startsWith("https://"),
    },
  );
}

export async function bindReboundProof(
  c: LinkContext,
  ctx: AppContext,
  adoption: FederatedSessionAdoption,
): Promise<void> {
  const hash = c.req.header("x-opensesame-next-proof");
  if (!hash || !/^[0-9a-f]{64}$/u.test(hash)) return;
  let bound = false;
  const session = await updateSecurityMap(
    ctx.stores.provisionalSessions,
    adoption.sessionId,
    (session) => {
      if (
        !session ||
        session.revokedAt ||
        session.principalId !== adoption.principalId
      )
        return session;
      bound = true;
      return { ...session, restoreProofHash: hash };
    },
  );
  if (!bound) throw new Error("The rebound session is no longer active.");
  if (session) await rememberProvisionalProof(ctx.stores, session);
}
