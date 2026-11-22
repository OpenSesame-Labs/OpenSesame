import { isString, overlapCast } from "@opensesame/os-domain";
import { host } from "../host.js";
import { maybePage, sessionStore } from "../ports.js";
import { isSealedAtRest } from "./at-rest/cipher.js";
import { atRestKeyNow } from "./at-rest/key.js";
import {
  identityPlaneRequest,
  isDeviceIdentityMode,
  resolveIdentityBase,
} from "./device-identity.js";
import {
  IdentityError,
  type IdentitySession,
} from "./identity-session-types.js";
import {
  type FailureClass,
  classifyResponse,
  classifyThrown,
} from "./probe-failure.js";

/** The reachability probe for the Identity plane, split out of identity.ts. */

export type HealthState = "unknown" | "reachable" | "unreachable";

/** A probe result that says *why*, for the connectivity monitor. */
export type ProbeResult = {
  health: HealthState;
  failure: FailureClass | null;
};

const GUEST_ISOLATION_KEY = "opensesame.guest.identity-isolated";
let orphanBase = "";

export function orphanActive(): boolean {
  return orphanBase === resolveIdentityBase();
}

export function updateOrphan(
  next: boolean | null,
  base = resolveIdentityBase(),
): boolean {
  if (
    next === null ||
    (!next && orphanBase !== base) ||
    (next && orphanBase === base)
  )
    return false;
  orphanBase = next ? base : "";
  return true;
}

/** The marker survives a reload even though the guest bearer does not. */
export function guestIsolationActive(): boolean {
  if (isDeviceIdentityMode()) return false;
  try {
    const raw = host().storage?.session?.getItem(GUEST_ISOLATION_KEY);
    if (raw != null && !isSealedAtRest(raw)) return true;
    const marker = sessionStore().getItem(GUEST_ISOLATION_KEY);
    return marker === "1" || (raw != null && marker !== "1");
  } catch {
    // A browser unable to read its marker cannot safely use an ambient cookie.
    return Boolean(maybePage()?.location);
  }
}

export function markGuestIsolation(): void {
  if (isDeviceIdentityMode()) return;
  try {
    if (!atRestKeyNow()?.durable) throw new Error("storage unavailable");
    const store = sessionStore();
    store.setItem(GUEST_ISOLATION_KEY, "1");
    if (
      store.getItem(GUEST_ISOLATION_KEY) !== "1" ||
      host().storage?.session?.getItem(GUEST_ISOLATION_KEY) == null
    )
      throw new Error("write failed");
  } catch {
    throw new IdentityError(
      "Allow browser session storage, then try again.",
      503,
    );
  }
}

export function clearGuestIsolation(): void {
  try {
    sessionStore().removeItem(GUEST_ISOLATION_KEY);
  } catch {
    // An unreadable marker stays fail-closed.
  }
}

export type IdentityCookieProbe =
  | { kind: "present"; principalId: string }
  | { kind: "absent" }
  | { kind: "unknown" };

export function cookieIdentitySession(
  principalId: string,
  issuerOrigin: string,
  issuerBase: string,
): IdentitySession {
  return {
    principalId,
    accessToken: `cookie:${principalId}`,
    cookieOnly: true,
    issuerOrigin,
    issuerBase,
  };
}

/** Inspect the cookie without adopting it or presenting a bearer. */
export async function probeIdentityCookie(
  timeoutMs: number,
): Promise<IdentityCookieProbe> {
  try {
    const res = await identityPlaneRequest("/v1/principals/me", {
      credentials: "include",
      timeoutMs,
    });
    if (res.status === 401) return { kind: "absent" };
    if (!res.ok) return { kind: "unknown" };
    const body = overlapCast(await res.json());
    return isString(body.id) && body.id
      ? { kind: "present", principalId: body.id }
      : { kind: "unknown" };
  } catch {
    return { kind: "unknown" };
  }
}

/** Does the cookie alone authenticate? `whenUnreachable` breaks the tie. */
export async function cookieAuthenticates(
  whenUnreachable: boolean,
  timeoutMs: number,
): Promise<boolean | null> {
  const base = resolveIdentityBase();
  try {
    const res = await identityPlaneRequest("/v1/principals/me", {
      credentials: "include",
      timeoutMs,
    });
    return resolveIdentityBase() === base ? res.ok : null;
  } catch {
    return resolveIdentityBase() === base ? whenUnreachable : null;
  }
}

export async function probeIdentityPlane(
  identityBase: () => string,
  timeoutMs: number,
): Promise<ProbeResult> {
  // Device-native mode is always the local host — never probe the network.
  if (isDeviceIdentityMode()) {
    return { health: "reachable", failure: null };
  }
  const base = identityBase();
  if (!base) return { health: "unreachable", failure: null };
  try {
    const res = await identityPlaneRequest("/v1/health/live", {
      credentials: "omit",
      timeoutMs,
    });
    if (!res.ok) {
      return { health: "unreachable", failure: classifyResponse(res.status) };
    }
    // A foreign listener on :8788 can answer with 401 JSON and look "up".
    // OpenSesame control-plane always returns `{ "status": "ok" }`.
    try {
      const body = overlapCast(await res.json());
      return body.status === "ok"
        ? { health: "reachable", failure: null }
        : { health: "unreachable", failure: "not-opensesame" };
    } catch {
      return { health: "unreachable", failure: "not-opensesame" };
    }
  } catch (error) {
    const thrown =
      error instanceof DOMException || error instanceof Error
        ? error
        : String(error);
    return { health: "unreachable", failure: classifyThrown(thrown) };
  }
}
