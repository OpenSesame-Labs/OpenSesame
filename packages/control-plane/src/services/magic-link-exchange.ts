/** A short-lived, verifier-bound completion; no session bearer enters the URL. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AppContext } from "../context.js";
import { DurableMap, takeSecurityMap } from "../repos/durable-map.js";
import type { BetterAuthSubject } from "./better-auth-bridge.js";

export type MagicLinkExchange = {
  subject: BetterAuthSubject;
  challenge: string;
  state: string;
  origin: string;
  expiresAt: Date;
};

const EXCHANGE_TTL_MS = 5 * 60_000;
const MAX_IN_MEMORY = 10_000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/u;
export const MAGIC_STATE = /^[A-Za-z0-9_-]{22,128}$/u;

export function validMagicChallenge(value: string): boolean {
  return TOKEN.test(value);
}

/** The durable map encrypts subject data and stores only a keyed code lookup. */
export async function issueMagicLinkExchange(
  ctx: AppContext,
  subject: BetterAuthSubject,
  challenge: string,
  state: string,
  origin: string,
): Promise<string> {
  if (!validMagicChallenge(challenge) || !MAGIC_STATE.test(state) || !origin)
    throw new Error("Invalid magic-link exchange context.");
  const store = ctx.stores.magicLinkExchanges;
  const now = ctx.clock().getTime();
  if (store instanceof Map) {
    for (const [key, value] of store) {
      if (value.expiresAt.getTime() <= now) store.delete(key);
    }
    if (store.size >= MAX_IN_MEMORY)
      throw new Error("The sign-in service is temporarily busy.");
  }
  const value: MagicLinkExchange = {
    subject,
    challenge,
    state,
    origin,
    expiresAt: new Date(now + EXCHANGE_TTL_MS),
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = randomBytes(32).toString("base64url");
    if (store instanceof DurableMap) {
      if (await store.claim(code, value)) return code;
    } else if (!store.has(code)) {
      store.set(code, value);
      return code;
    }
  }
  throw new Error("The sign-in service is temporarily busy.");
}

/** Consumption is atomic across replicas; a wrong verifier burns the code. */
export async function consumeMagicLinkExchange(
  ctx: AppContext,
  code: string,
  verifier: string,
  state: string,
  origin: string,
): Promise<BetterAuthSubject | undefined> {
  if (
    !TOKEN.test(code) ||
    !VERIFIER.test(verifier) ||
    !MAGIC_STATE.test(state) ||
    !origin
  )
    return undefined;
  const exchange = await takeSecurityMap(ctx.stores.magicLinkExchanges, code);
  if (!exchange || exchange.expiresAt.getTime() <= ctx.clock().getTime())
    return undefined;
  const actual = createHash("sha256").update(verifier).digest("base64url");
  if (
    exchange.state !== state ||
    exchange.origin !== origin ||
    actual.length !== exchange.challenge.length ||
    !timingSafeEqual(Buffer.from(actual), Buffer.from(exchange.challenge))
  )
    return undefined;
  return exchange.subject;
}
