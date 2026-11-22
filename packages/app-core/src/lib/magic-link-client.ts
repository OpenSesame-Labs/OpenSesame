import {
  type BoundaryValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { randomString, sha256Base64Url } from "@opensesame/sdk-browser";
import { page, sessionStore } from "../ports.js";
import {
  identitySessionEpoch,
  remoteIdentityApi,
  restoreSession,
} from "./identity.js";
import { localNetworkFetch } from "./local-network-fetch.js";

const PENDING_KEY = "opensesame.magic-link.pending.v1";

type PendingMagicLink = {
  verifier: string;
  state: string;
  identityBase: string;
  callback: string;
  sessionEpoch: number;
};

function readPending(): PendingMagicLink | undefined {
  const raw = sessionStore().getItem(PENDING_KEY);
  if (!raw) return undefined;
  try {
    const value: BoundaryValue = overlapCast(JSON.parse(raw));
    if (
      !isJsonObject(value) ||
      !isString(value.verifier) ||
      !isString(value.state) ||
      !isString(value.identityBase) ||
      !isString(value.callback) ||
      typeof value.sessionEpoch !== "number"
    )
      return undefined;
    return overlapCast(value);
  } catch {
    return undefined;
  }
}

export async function beginMagicLink(email: string): Promise<{
  request: RequestInit;
  commit: () => void;
}> {
  const identityBase = remoteIdentityApi();
  if (!identityBase) throw new Error("No sign-in service is connected.");
  const verifier = randomString(32);
  const state = randomString(24);
  const callbackUrl = new URL(page().location.href);
  for (const key of ["magic_code", "magic_state"])
    callbackUrl.searchParams.delete(key);
  const pending: PendingMagicLink = {
    verifier,
    state,
    identityBase,
    callback: callbackUrl.toString(),
    sessionEpoch: identitySessionEpoch(),
  };
  return {
    request: {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "omit",
      body: JSON.stringify({
        email,
        callbackURL: pending.callback,
        codeChallenge: await sha256Base64Url(verifier),
        state,
      }),
    },
    commit: () => sessionStore().setItem(PENDING_KEY, JSON.stringify(pending)),
  };
}

export async function completeMagicLink(
  code: string,
  state: string,
  assertCurrent: () => void,
): Promise<boolean> {
  const pending = readPending();
  sessionStore().removeItem(PENDING_KEY);
  if (
    !pending ||
    pending.state !== state ||
    pending.identityBase !== remoteIdentityApi()
  )
    throw new Error("This sign-in return did not match the requesting tab.");
  assertCurrent();
  const response = await localNetworkFetch(
    `${pending.identityBase}/v1/auth/magic-link/exchange`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "omit",
      body: JSON.stringify({ code, codeVerifier: pending.verifier, state }),
      timeoutMs: 6000,
    },
  );
  if (!response.ok) throw new Error("This sign-in link is invalid or expired.");
  const body: BoundaryValue = overlapCast(await response.json());
  if (
    !isJsonObject(body) ||
    !isString(body.principalId) ||
    !isString(body.accessToken)
  )
    throw new Error("The sign-in service returned an invalid session.");
  assertCurrent();
  restoreSession(
    {
      principalId: body.principalId,
      accessToken: body.accessToken,
      issuerOrigin: new URL(pending.identityBase).origin,
    },
    pending.sessionEpoch,
  );
  return true;
}

export async function completeMagicLinkIfPresent(
  search: string,
  scrub: () => void,
  assertCurrent: () => void,
): Promise<boolean> {
  const params = new URLSearchParams(search);
  const code = params.get("magic_code");
  const state = params.get("magic_state");
  if (!code && !state) return false;
  if (!code || !state) throw new Error("The sign-in return is incomplete.");
  scrub();
  return completeMagicLink(code, state, assertCurrent);
}
