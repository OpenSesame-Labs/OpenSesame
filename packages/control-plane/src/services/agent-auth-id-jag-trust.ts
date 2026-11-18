import { agentAuthError } from "@opensesame/agent-protocols";
import type { UnitOfWork } from "@opensesame/database";
import {
  type BoundaryValue,
  type JsonObject,
  isFunction,
  isJsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import type { AgentAuthTrustedProvider } from "../config.js";
import type { AppContext } from "../context.js";
import { guardedFetch } from "./guarded-fetch.js";

export function providerAssertionIsAdvertised(
  cfg: AppContext["config"]["agentAuth"],
): boolean {
  return (
    cfg.enabled &&
    cfg.providerAssertionEnabled &&
    cfg.trustedProviders.some((provider) => provider.enabled)
  );
}

const providerReplayFallback = new Map<string, number>();

export async function consumeProviderReplay(
  ctx: AppContext,
  issuer: string,
  jti: string,
  expiresAt: Date,
  uow?: UnitOfWork,
): Promise<boolean> {
  const consume = ctx.repos.agentAuth.consumeProviderAssertionReplay;
  if (isFunction(consume)) {
    return consume(issuer, jti, expiresAt, uow);
  }
  const key = `${issuer}\0${jti}`;
  const now = Date.now();
  for (const [seen, exp] of providerReplayFallback) {
    if (exp <= now) providerReplayFallback.delete(seen);
  }
  if (providerReplayFallback.has(key)) return false;
  providerReplayFallback.set(key, expiresAt.getTime());
  return true;
}

export function trustedProviderFor(
  cfg: AppContext["config"]["agentAuth"],
  issuer: string,
): AgentAuthTrustedProvider | undefined {
  const normalized = issuer.replace(/\/+$/u, "");
  return cfg.trustedProviders.find(
    (provider) =>
      provider.enabled && provider.issuer.replace(/\/+$/u, "") === normalized,
  );
}

export type ProviderJwks = { keys: JsonObject[] };
const MAX_JWKS_BYTES = 65_536;

/** Bound actual response bytes even when a transport supplies a stream. */
async function readJwksBody(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_JWKS_BYTES) {
    await response.body?.cancel();
    throw new Error("JWKS too large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_JWKS_BYTES) {
        await reader.cancel();
        throw new Error("JWKS too large");
      }
      body += decoder.decode(next.value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export async function jwksForProvider(
  provider: AgentAuthTrustedProvider,
): Promise<ProviderJwks> {
  if (provider.jwks?.keys && provider.jwks.keys.length > 0) {
    return provider.jwks;
  }
  if (!provider.jwksUri) {
    throw agentAuthError("invalid_request", 400, "provider keys unavailable");
  }
  let body: string;
  try {
    const uri = new URL(provider.jwksUri);
    if (uri.protocol !== "https:") throw new Error("HTTPS is required");
    const response = await guardedFetch(uri, true, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
      maxBytes: MAX_JWKS_BYTES,
    });
    if (!response.ok) throw new Error("JWKS request failed");
    body = await readJwksBody(response);
  } catch {
    throw agentAuthError("invalid_request", 400, "provider JWKS fetch failed");
  }
  let parsed: BoundaryValue;
  try {
    parsed = overlapCast(JSON.parse(body));
  } catch {
    throw agentAuthError("invalid_request", 400, "provider JWKS is not JSON");
  }
  if (
    !isJsonObject(parsed) ||
    !Array.isArray(parsed.keys) ||
    parsed.keys.length === 0 ||
    !parsed.keys.every(isJsonObject)
  ) {
    throw agentAuthError("invalid_request", 400, "provider JWKS has no keys");
  }
  return { keys: parsed.keys };
}
