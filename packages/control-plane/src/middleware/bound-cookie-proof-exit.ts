import { createHash, timingSafeEqual } from "node:crypto";
import type { ProvisionalSession } from "@opensesame/os-domain";
import type { Context } from "hono";
import { deleteCookie } from "hono/cookie";
import {
  beginProvisionalRevocation,
  finishProvisionalRevocation,
  provisionalRevocationComplete,
} from "../repos/provisional-revocation.js";
import { serializeKeyed } from "../serialize.js";
import { cookieAuthAllowed } from "./auth.js";
import {
  boundCookieName,
  boundCookiePath,
  boundCookieSameSite,
  validBoundSessionId,
} from "./bound-cookie-name.js";
import type { Variables } from "./context.js";

function matchesProof(
  session: ProvisionalSession,
  principal: string,
  supplied: Buffer,
): boolean {
  return (
    session.principalId === principal &&
    Boolean(
      session.restoreProofHash &&
        /^[0-9a-f]{64}$/u.test(session.restoreProofHash) &&
        timingSafeEqual(supplied, Buffer.from(session.restoreProofHash, "hex")),
    )
  );
}

/** A tab's proof can revoke its exact session even if the cookie disappeared. */
export async function boundCookieProofExit(
  c: Context<{ Variables: Variables }>,
): Promise<Response> {
  const ctx = c.get("ctx");
  c.header("Cache-Control", "no-store");
  if (!cookieAuthAllowed(ctx, c.req.method, c.req.header("origin")))
    return c.json({ error: "forbidden" }, 403);
  const id = c.req.header("x-opensesame-revoke-session") ?? "";
  const proof = c.req.header("x-opensesame-revoke-secret") ?? "";
  const principal = c.req.header("x-opensesame-revoke-principal") ?? "";
  if (
    !validBoundSessionId(id) ||
    !/^[0-9a-f]{64}$/u.test(proof) ||
    !principal ||
    principal.length > 200
  )
    return c.json({ error: "invalid_request" }, 400);
  const supplied = createHash("sha256").update(proof).digest();
  return serializeKeyed(
    ctx.stores.principalMutations,
    `proof-revoke:${id}`,
    async () => {
      const observed = await ctx.stores.provisionalSessions.get(id);
      // Missing and mismatched sessions are intentionally indistinguishable;
      // a caller must prove the exact high-entropy record before this endpoint
      // reports a completed revocation.
      if (!observed) {
        const tombstone = await ctx.stores.provisionalProofs.get(id);
        const verified = Boolean(
          tombstone &&
            tombstone.principalId === principal &&
            /^[0-9a-f]{64}$/u.test(tombstone.restoreProofHash) &&
            timingSafeEqual(
              supplied,
              Buffer.from(tombstone.restoreProofHash, "hex"),
            ),
        );
        // With no live row and no retained proof, the remote session has
        // expired. Treat a well-formed retry as terminal so an offline browser
        // cannot retain its local sign-out fence forever. While a tombstone
        // exists, a mismatched proof still fails closed.
        return tombstone && !verified
          ? c.json({ error: "unauthorized" }, 401)
          : c.body(null, 204);
      }
      if (!matchesProof(observed, principal, supplied))
        return c.json({ error: "unauthorized" }, 401);
      // A completed retry must be read-only. In particular, do not send an
      // unchanged record through the durable map's locking upsert on replay.
      if (
        observed.revokedAt &&
        !observed.revocationCleanupPending &&
        (await provisionalRevocationComplete(ctx, observed))
      ) {
        deleteCookie(c, boundCookieName(ctx.config.provisionalCookieName, id), {
          httpOnly: true,
          sameSite: boundCookieSameSite(ctx.config.publicUrl),
          path: boundCookiePath(ctx.config.publicUrl),
          secure: ctx.config.publicUrl.startsWith("https://"),
        });
        return c.body(null, 204);
      }
      const pending = await beginProvisionalRevocation(
        ctx,
        id,
        {
          actorType: "human",
          correlationId: c.get("correlationId"),
          metadata: { action: "principal.provisional_revoke" },
        },
        (session) => matchesProof(session, principal, supplied),
      );
      if (!pending) {
        return c.json({ error: "unauthorized" }, 401);
      }
      if (!matchesProof(pending, principal, supplied))
        return c.json({ error: "unauthorized" }, 401);
      await finishProvisionalRevocation(ctx, id);
      deleteCookie(c, boundCookieName(ctx.config.provisionalCookieName, id), {
        httpOnly: true,
        sameSite: boundCookieSameSite(ctx.config.publicUrl),
        path: boundCookiePath(ctx.config.publicUrl),
        secure: ctx.config.publicUrl.startsWith("https://"),
      });
      return c.body(null, 204);
    },
  );
}
