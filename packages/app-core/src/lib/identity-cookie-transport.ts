/** Cookie-only status and revocation do not expose a bearer to the tab. */
import { isJsonObject, isString, overlapCast } from "@opensesame/os-domain";
import { maybePage } from "../ports.js";
import {
  deviceIdentityOrigin,
  identityPlaneRequest,
  isDeviceIdentityMode,
  resolveIdentityBase,
} from "./device-identity.js";
import type { readCookieBinding } from "./identity-cookie-binding.js";

const IDENTITY_FETCH_MS = 8000;
const PROBE_MS = 4000;

function validSlots(value: unknown): value is {
  sessions: string[];
  more?: boolean;
} {
  const body = overlapCast(value);
  return (
    isJsonObject(body) &&
    Array.isArray(body.sessions) &&
    body.sessions.every(isString) &&
    (body.more === undefined || typeof body.more === "boolean")
  );
}

/** Pin the configured Identity service, including its reverse-proxy path. */
export function identityOriginFor(base: () => string): string {
  if (isDeviceIdentityMode()) return deviceIdentityOrigin();
  try {
    const url = new URL(base());
    if (url.username || url.password || url.search || url.hash) return "";
    return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
  } catch {
    return "";
  }
}

/** Interpret an unreachable cookie according to the caller's safety boundary. */
export async function cookieAuthenticates(
  whenUnreachable: boolean,
): Promise<boolean> {
  const state = await inspectIdentityCookie();
  return state === "present" || (state === "unknown" && whenUnreachable);
}

/** A cross-origin fetch may omit an existing SameSite=Lax legacy cookie. */
export const cookieInspectionSeams = {
  canObserveLegacyCookie(): boolean {
    const page = maybePage();
    if (!page) return true;
    try {
      const identity = new URL(resolveIdentityBase());
      const current = new URL(page.location.origin);
      return (
        identity.protocol === current.protocol &&
        identity.hostname === current.hostname
      );
    } catch {
      return false;
    }
  },
};

/** An unreachable service is not evidence that a shared cookie is absent. */
export async function inspectIdentityCookie(): Promise<
  "present" | "absent" | "unknown"
> {
  if (isDeviceIdentityMode()) return "absent";
  try {
    const slots = await identityPlaneRequest("/v1/bound/status", {
      credentials: "include",
      cache: "no-store",
      timeoutMs: PROBE_MS,
    });
    if (slots.ok) {
      const body: unknown = await slots.json();
      if (!validSlots(body)) return "unknown";
      if (body.sessions.length > 0 || body.more === true) return "present";
    } else return "unknown";
    const res = await identityPlaneRequest("/v1/principals/me", {
      credentials: "include",
      cache: "no-store",
      timeoutMs: PROBE_MS,
    });
    if (res.ok) return "present";
    return res.status === 401 && cookieInspectionSeams.canObserveLegacyCookie()
      ? "absent"
      : "unknown";
  } catch {
    return "unknown";
  }
}

export async function revokeBoundCookie(
  binding: NonNullable<ReturnType<typeof readCookieBinding>>,
): Promise<Response> {
  return identityPlaneRequest("/v1/bound/proof-sign-out", {
    method: "POST",
    credentials: "include",
    timeoutMs: IDENTITY_FETCH_MS,
    headers: {
      "x-opensesame-revoke-session": binding.sessionId,
      "x-opensesame-revoke-secret": binding.proof,
      "x-opensesame-revoke-principal": binding.principalId,
    },
  });
}

export async function revokeObservedCookie(
  check: () => void = () => {},
): Promise<Response> {
  for (let page = 0; page < 128; page += 1) {
    check();
    const slots = await identityPlaneRequest("/v1/bound/status", {
      credentials: "include",
      cache: "no-store",
      timeoutMs: PROBE_MS,
    });
    check();
    // A 404 can come from an older replica while another replica has issued
    // bound cookies. It cannot prove that all browser sessions were revoked.
    if (slots.status === 404) return new Response(null, { status: 503 });
    if (!slots.ok) return slots;
    const body: unknown = await slots.json();
    if (!validSlots(body)) return new Response(null, { status: 502 });
    for (const id of body.sessions) {
      check();
      const result = await identityPlaneRequest("/v1/bound/sign-out", {
        method: "POST",
        credentials: "include",
        timeoutMs: IDENTITY_FETCH_MS,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: id }),
      });
      check();
      if (!result.ok) return result;
    }
    if (body.more !== true) break;
    if (page === 127) return new Response(null, { status: 409 });
  }
  check();
  const status = await identityPlaneRequest("/v1/principals/cookie-status", {
    credentials: "include",
    cache: "no-store",
    timeoutMs: PROBE_MS,
  });
  check();
  if (status.status === 401)
    return new Response(null, {
      status: cookieInspectionSeams.canObserveLegacyCookie() ? 204 : 503,
    });
  if (!status.ok) return status;
  const body = overlapCast(await status.json());
  check();
  if (!isString(body.sessionId) || !body.sessionId)
    return new Response(null, { status: 502 });
  const response = await identityPlaneRequest(
    "/v1/principals/cookie-sign-out",
    {
      method: "POST",
      credentials: "include",
      timeoutMs: IDENTITY_FETCH_MS,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: body.sessionId }),
    },
  );
  check();
  return response;
}

export function revokeRequest(
  bearer?: string,
  credentials: RequestCredentials = "include",
): Promise<Response> {
  return identityPlaneRequest("/v1/principals/provisional/revoke", {
    method: "POST",
    credentials,
    timeoutMs: IDENTITY_FETCH_MS,
    ...(bearer
      ? { headers: { authorization: `Bearer ${bearer}` } }
      : undefined),
  });
}
