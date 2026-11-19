/** Signed callback context ties an emailed proof to the initiating browser. */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { MagicLinkMetadata } from "@opensesame/auth-upstream";
import { FORBIDDEN_URL_PARAMS } from "@opensesame/os-domain";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { stripTrailingSlashes } from "../interactions/issuer-normalization.js";
import { MAGIC_STATE, validMagicChallenge } from "./magic-link-exchange.js";

export const MAGIC_LINK_INTERACTION_KEY = "interactionUid";
export const MAGIC_CALLBACK = "magicCallback";
export const MAGIC_CHALLENGE = "magicChallenge";
export const MAGIC_STATE_KEY = "magicState";
const MAX_URL = 2048;
const MAX_CONTEXT = 4096;
const LIFETIME_MS = 600_000;
const DIGEST = /^[A-Za-z0-9_-]{43}$/u;
const encoded = /^[A-Za-z0-9_-]+$/u;

const returnSchema = z.object({
  callback: z.string().max(MAX_URL),
  challenge: z.string().regex(DIGEST),
  state: z.string().regex(MAGIC_STATE),
  tokenHash: z.string().regex(DIGEST),
  expiresAt: z.number().int().safe(),
});
export type MagicLinkReturn = z.infer<typeof returnSchema>;

/** A return is trusted only within the caller's configured client application. */
export function approvedMagicCallback(
  ctx: AppContext,
  raw: string,
  origin?: string,
): URL | undefined {
  if (!raw || raw.length > MAX_URL) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
    const decodedPath = decodeURIComponent(url.pathname);
    if (
      decodedPath.includes("\\") ||
      decodedPath.split("/").some((part) => part === "." || part === "..")
    )
      return undefined;
  } catch {
    return undefined;
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.hash ||
    (origin !== undefined && url.origin !== origin) ||
    !ctx.config.corsOrigins.includes(url.origin)
  )
    return undefined;
  for (const name of url.searchParams.keys()) {
    const lower = name.toLowerCase();
    if (
      FORBIDDEN_URL_PARAMS.includes(lower) ||
      lower === "magic_code" ||
      lower === "magic_state"
    )
      return undefined;
  }
  if (ctx.config.clientAppUrl) {
    const base = new URL(ctx.config.clientAppUrl);
    const path = base.pathname.replace(/\/+$/u, "");
    if (
      url.origin !== base.origin ||
      (path && url.pathname !== path && !url.pathname.startsWith(`${path}/`))
    )
      return undefined;
  }
  return url;
}

function signature(ctx: AppContext, payload: string): string {
  return createHmac("sha256", ctx.config.claimPepper)
    .update("opensesame/magic-link-return/v1\0")
    .update(payload)
    .digest("base64url");
}

function signedReturn(
  ctx: AppContext,
  token: string,
  callback: string,
  challenge: string,
  state: string,
): string {
  const value: MagicLinkReturn = {
    callback,
    challenge,
    state,
    tokenHash: createHash("sha256").update(token).digest("base64url"),
    expiresAt: ctx.clock().getTime() + LIFETIME_MS,
  };
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${signature(ctx, payload)}`;
}

export function openMagicLinkReturn(
  ctx: AppContext,
  token: string,
  raw: string,
): MagicLinkReturn | undefined {
  if (!raw || raw.length > MAX_CONTEXT) return undefined;
  const parts = raw.split(".");
  const [payload, supplied] = parts;
  if (
    parts.length !== 2 ||
    !payload ||
    !encoded.test(payload) ||
    !supplied ||
    !DIGEST.test(supplied)
  )
    return undefined;
  const expected = signature(ctx, payload);
  if (!timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)))
    return undefined;
  try {
    const parsed = returnSchema.safeParse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    if (!parsed.success) return undefined;
    const value = parsed.data;
    if (
      value.expiresAt <= ctx.clock().getTime() ||
      value.tokenHash !==
        createHash("sha256").update(token).digest("base64url") ||
      !approvedMagicCallback(ctx, value.callback)
    )
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}

/** Hosted interactions keep their existing path; first-party returns carry a signed context. */
export function magicLinkUrl(
  ctx: AppContext,
  token: string,
  metadata: MagicLinkMetadata | undefined,
): string {
  const base = stripTrailingSlashes(ctx.config.publicUrl);
  const uid = metadata?.[MAGIC_LINK_INTERACTION_KEY];
  const query = new URLSearchParams({ token });
  if (uid)
    return `${base}/interaction/${encodeURIComponent(uid)}/federated/email/verify?${query}`;
  const callback = metadata?.[MAGIC_CALLBACK];
  const challenge = metadata?.[MAGIC_CHALLENGE];
  const state = metadata?.[MAGIC_STATE_KEY];
  if (
    !callback ||
    !challenge ||
    !state ||
    !approvedMagicCallback(ctx, callback) ||
    !validMagicChallenge(challenge) ||
    !MAGIC_STATE.test(state)
  )
    throw new Error("Invalid magic-link return context.");
  query.set("return", signedReturn(ctx, token, callback, challenge, state));
  return `${base}/v1/auth/magic-link/complete#${query}`;
}
