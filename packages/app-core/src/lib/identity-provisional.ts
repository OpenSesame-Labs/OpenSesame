/** Mint a provisional identity only for the original tab and session lifetime. */
import { type JsonObject, isString, overlapCast } from "@opensesame/os-domain";
import {
  identityPlaneRequest,
  isDeviceIdentityMode,
} from "./device-identity.js";
import {
  clearCookieBinding,
  clearMatchingCookieBinding,
  newCookieProof,
  saveCookieBinding,
} from "./identity-cookie-binding.js";
import { readCookieSession } from "./identity-cookie-session.js";
import { inspectIdentityCookie } from "./identity-cookie-transport.js";
import {
  IdentityError,
  type IdentitySession,
} from "./identity-session-types.js";
import { readError } from "./identity-token-proof.js";

type Host = {
  active: () => IdentitySession | null;
  epoch: () => number;
  origin: () => string;
  resume: () => Promise<IdentitySession | null>;
  orphan: () => void;
  revoke: (token: string) => void;
  publish: (session: IdentitySession) => void;
};
export type ProvisionalOptions = {
  fresh?: boolean;
  explicitSignIn?: boolean;
  check?: () => void;
};
type Minted = {
  principalId: string;
  accessToken: string;
  sessionId?: string;
  expiresAt?: string;
  unverifiedBrowserSessions?: boolean;
};

async function requireEmptyCookie(
  host: Host,
  epoch: number,
  check: () => void,
  explicitSignIn: boolean,
): Promise<boolean> {
  const state = await inspectIdentityCookie();
  check();
  if (epoch !== host.epoch())
    throw new IdentityError(
      "The session ended while connecting. Connect again.",
      409,
    );
  if (state === "present") {
    host.orphan();
    throw new IdentityError(
      "Sign out of the existing session before starting another.",
      409,
    );
  }
  if (state === "unknown" && !explicitSignIn)
    throw new IdentityError(
      "The existing Identity sign-in could not be verified. Check your connection or use Identity on the same host and scheme as this app.",
      503,
    );
  return state !== "unknown";
}

function parseMinted(
  body: JsonObject,
  device: boolean,
  bound: boolean,
): Minted {
  if (
    !isString(body.principalId) ||
    !isString(body.accessToken) ||
    (!device && bound && !isString(body.sessionId)) ||
    (body.expiresAt !== undefined && !isString(body.expiresAt))
  )
    throw new IdentityError(
      "Identity returned an invalid provisional session.",
      502,
    );
  return {
    principalId: body.principalId,
    accessToken: body.accessToken,
    sessionId: bound && isString(body.sessionId) ? body.sessionId : undefined,
    expiresAt: isString(body.expiresAt) ? body.expiresAt : undefined,
    unverifiedBrowserSessions: !device && !bound,
  };
}

async function mint(hash: string, bound: boolean): Promise<Minted> {
  const device = isDeviceIdentityMode();
  const res = await identityPlaneRequest(
    device || !bound ? "/v1/principals/provisional" : "/v1/bound/session-mint",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: bound ? "include" : "omit",
      body: JSON.stringify(bound ? { restoreProofHash: hash } : {}),
      timeoutMs: 8000,
    },
  );
  if (
    !device &&
    bound &&
    res.ok &&
    res.headers.get("x-opensesame-cookie-bound") !== "1"
  )
    throw new IdentityError(
      "Identity must be updated before a new session can start.",
      503,
    );
  if (!res.ok) throw new IdentityError(await readError(res), res.status);
  const body: JsonObject = overlapCast(await res.json());
  return parseMinted(body, device, bound);
}

async function publishMinted(
  host: Host,
  body: Minted,
  proof: string,
  epoch: number,
  origin: string,
  check: () => void,
): Promise<IdentitySession> {
  const next: IdentitySession = {
    principalId: body.principalId,
    accessToken: body.accessToken,
    expiresAt: body.expiresAt,
    issuerOrigin: origin,
    unverifiedBrowserSessions: body.unverifiedBrowserSessions,
  };
  const current = () => {
    check();
    return (
      host.epoch() === epoch &&
      host.active() === null &&
      host.origin() === origin
    );
  };
  const candidate =
    body.sessionId && !isDeviceIdentityMode()
      ? {
          issuerOrigin: origin,
          principalId: body.principalId,
          sessionId: body.sessionId,
          proof,
        }
      : null;
  try {
    if (!current()) throw new Error("Session changed");
    if (!candidate) clearCookieBinding();
    if (candidate) {
      const persisted = saveCookieBinding(candidate);
      const restored = persisted && (await readCookieSession(origin, current));
      if (!restored) clearMatchingCookieBinding(candidate);
    }
    if (!current()) throw new Error("Session changed");
  } catch {
    if (candidate) clearMatchingCookieBinding(candidate);
    host.revoke(next.accessToken);
    throw new IdentityError(
      "The session was ended while connecting. Connect again.",
      409,
    );
  }
  host.publish(next);
  return next;
}

export async function connectProvisionalLocked(
  options: ProvisionalOptions | undefined,
  host: Host,
): Promise<IdentitySession> {
  const check = options?.check ?? (() => {});
  check();
  if (!options?.fresh) {
    const resumed = await host.resume();
    check();
    if (resumed) return resumed;
  } else if (host.active())
    throw new IdentityError(
      "The session changed while connecting. Connect again.",
      409,
    );
  const epoch = host.epoch();
  const bound = await requireEmptyCookie(
    host,
    epoch,
    check,
    options?.explicitSignIn === true,
  );
  const proof = await newCookieProof();
  check();
  if (epoch !== host.epoch() || host.active())
    throw new IdentityError(
      "The session changed while connecting. Connect again.",
      409,
    );
  const origin = host.origin();
  const body = await mint(proof.hash, bound);
  return publishMinted(host, body, proof.proof, epoch, origin, check);
}
