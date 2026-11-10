import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { vi } from "vitest";

/**
 * Fetch doubles for the `runCli` command tests: a routed `fetch` and the
 * canned issuer responses it serves. No state lives here, so a test file
 * keeps its own captured streams, state directory and session file.
 */

export const ISSUER = "http://127.0.0.1:8788";

type Route = (
  url: string,
  init?: RequestInit,
) => Response | Promise<Response> | undefined;

/** Answers the first route that matches; anything else throws loudly. */
export function routerFetch(...routes: Route[]): typeof fetch {
  return overlapCast(
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      for (const route of routes) {
        const res = await route(url, init);
        if (res) return res;
      }
      throw new Error(`unexpected ${url}`);
    }),
  );
}

export function json(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export const discoveryDoc = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/auth`,
  token_endpoint: `${ISSUER}/token`,
  device_authorization_endpoint: `${ISSUER}/device`,
  jwks_uri: `${ISSUER}/jwks`,
};

/** Discovery + device endpoints that complete the device flow immediately. */
export function deviceFlowFetch(): typeof fetch {
  return routerFetch((url) => {
    if (url.includes("openid-configuration")) return json(discoveryDoc);
    if (url.endsWith("/device")) {
      return json({
        device_code: "dc",
        user_code: "ABCD-EFGH",
        verification_uri: `${ISSUER}/device`,
        verification_uri_complete: `${ISSUER}/device?user_code=ABCD-EFGH`,
        expires_in: 600,
        interval: 1,
      });
    }
    if (url.endsWith("/token")) {
      return json({
        access_token: "at-device",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    return undefined;
  });
}

export const guestSessionBody = {
  principalId: "prn_guest",
  state: "provisional",
  assurance: "provisional",
  sessionId: "ps_1",
  accessToken: "pst_guest",
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  tokenType: "Bearer",
};
