import { overlapCast } from "@opensesame/os-domain";
import type * as client from "openid-client";
import type { ControlPlaneConfig } from "../config.js";
import { guardedLibraryFetch } from "../services/guarded-fetch.js";

/** Small process-local TTL/LRU used for credential-bound discovery results. */
export class TtlLru<T> {
  readonly #entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
  ) {}

  clear(): void {
    this.#entries.clear();
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  get(key: string, now: number): T | undefined {
    for (const [cachedKey, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(cachedKey);
    }
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, now: number): void {
    this.#entries.set(key, { value, expiresAt: now + this.ttlMs });
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}

/** Our own public origin — what an origin-profile client id encodes. */
export function siteOrigin(config: ControlPlaneConfig): string {
  return new URL(config.publicUrl).origin;
}

/** The two facts about a client mode that decide how its requests travel. */
export type UpstreamFetchMode = { originProfile: boolean; fenced?: true };

/**
 * A broker validating an origin-profile client checks the `Origin` header
 * byte-equals the origin encoded in the client id (see
 * `tools/mock-upstream-idp/src/server.ts`, which answers `origin_cors_denied`
 * otherwise). A browser sets that header itself; a server-side exchange must
 * set it explicitly, and it must be our real public origin — the same value
 * already baked into the client id, so this asserts nothing new.
 *
 * A fenced mode (a BYO record or an organization's issuer, which anyone can
 * create or an org owner can point anywhere) routes every request openid-client
 * makes — discovery, token, revocation — through `guardedFetch`: the name is
 * resolved, private answers are refused and the socket is pinned (T21).
 */
export function upstreamFetch(
  config: ControlPlaneConfig,
  mode: UpstreamFetchMode,
): client.CustomFetch {
  const pin = mode.originProfile ? { Origin: siteOrigin(config) } : {};
  if (mode.fenced) return guardedLibraryFetch(!config.allowDevDefaults, pin);
  return (url, options) => {
    // SAFETY: CustomFetchOptions is the fetch init shape openid-client already
    // built (method/headers/body/signal); only the Origin header is added.
    const init: RequestInit = overlapCast({
      ...options,
      headers: { ...options.headers, ...pin },
    });
    return fetch(url, init);
  };
}
