/** Rate limits for anonymous and interactive provisional session creation. */
import { createHash } from "node:crypto";
import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import type { Context } from "hono";
import { peerAddress } from "../lib/peer-address.js";
import { cookieAuthAllowed } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";

const PROVISIONAL_MINT_WINDOW_MS = 60_000;
const PROVISIONAL_MINT_PER_CLIENT = 10;
const PROVISIONAL_MINT_GLOBAL = 120;
const PROVISIONAL_MINT_KEYS = 2_048;
const PROVISIONAL_MINT_CLIENT_PREFIX = "client:";

export type ProvisionalMintScope = "public" | "interaction";

/**
 * Charge one mint against a scope. Public minting and interactive sign-in keep
 * separate global ceilings: exhausting the unauthenticated public route must
 * not lock every user out of SAML/OIDC/LDAP/email sign-in.
 */
export function consumeProvisionalMintBudget(
  map: Map<string, number[]>,
  fingerprint: string,
  now: number,
  scope: ProvisionalMintScope = "public",
  perClientLimit = PROVISIONAL_MINT_PER_CLIENT,
): boolean {
  for (const [key, values] of map) {
    const live = values.filter((at) => now - at < PROVISIONAL_MINT_WINDOW_MS);
    if (live.length === 0) map.delete(key);
    else if (live.length !== values.length) map.set(key, live);
  }
  const globalKey = `__global__:${scope}`;
  const clientKey = `${PROVISIONAL_MINT_CLIENT_PREFIX}${scope}:${fingerprint}`;
  const global = map.get(globalKey) ?? [];
  const client = map.get(clientKey) ?? [];
  if (
    global.length >= PROVISIONAL_MINT_GLOBAL ||
    client.length >= perClientLimit
  ) {
    return false;
  }
  global.push(now);
  client.push(now);
  map.set(globalKey, global);
  map.set(clientKey, client);
  while (map.size > PROVISIONAL_MINT_KEYS) {
    // Global ceilings are never the victim: evicting one would reset the one
    // budget a caller cannot rotate their fingerprint to escape.
    const victim = [...map.keys()].find((key) => !key.startsWith("__global__"));
    if (victim === undefined) break;
    map.delete(victim);
  }
  return true;
}

/**
 * The mint budget's client key. The connection address is server-observed. A
 * caller cannot rotate User-Agent or Origin to get another bucket while a peer
 * address is available; those headers are a fallback for in-process tests only.
 */
export function provisionalMintFingerprint(
  c: Context<{ Variables: Variables }>,
): string {
  const address = peerAddress(c);
  return createHash("sha256")
    .update(address ?? "")
    .update("|")
    .update(address ? "" : (c.req.header("user-agent") ?? ""))
    .digest("hex")
    .slice(0, 16);
}

/**
 * A shared peer address (NAT, office, test runner) is one bucket, so allow a
 * larger ceiling than the old spoofable-header bucket. The 60/minute cap still
 * bounds one host, while the global public ceiling stays at 120/minute.
 */
export function provisionalMintPerClient(
  c: Context<{ Variables: Variables }>,
): number {
  return peerAddress(c) ? 60 : 10;
}

/** Bound cookie minting requires an allowed origin and a JSON request. */
export function allowsBoundMint(c: Context<{ Variables: Variables }>): boolean {
  return (
    cookieAuthAllowed(c.get("ctx"), c.req.method, c.req.header("origin")) &&
    /^application\/json(?:\s*;|$)/iu.test(c.req.header("content-type") ?? "")
  );
}

/** Parse the optional proof without admitting malformed mint requests. */
export function parseProvisionalMintBody(
  raw: string,
): { ok: true; restoreProofHash?: string } | { ok: false } {
  if (!raw) return { ok: true };
  try {
    const body: BoundaryValue = JSON.parse(raw);
    if (!isJsonObject(body)) return { ok: false };
    if (!("restoreProofHash" in body)) return { ok: true };
    return isString(body.restoreProofHash) &&
      /^[0-9a-f]{64}$/u.test(body.restoreProofHash)
      ? { ok: true, restoreProofHash: body.restoreProofHash }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}
