import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { randomString, sha256Base64Url } from "@opensesame/sdk-browser";
import { page, sessionStore } from "../ports.js";
import { currentAuthGeneration } from "./auth-generation.js";
import {
  identitySessionEpoch,
  remoteIdentityApi,
  restoreSession,
} from "./identity.js";
import {
  flushBearerRevokes,
  queueIdentityRevoke,
  rememberBearerRevoke,
} from "./identity-token-proof.js";
import { localNetworkFetch } from "./local-network-fetch.js";

const PENDING_KEY = "opensesame.magic-link.pending.v1";
/**
 * Names this page load. The session epoch is module memory and restarts when
 * the email link reloads the app, so a recorded epoch fences only a return
 * that lands in the same page load that asked for the link.
 */
const pageLoad = randomString(16);

type PendingMagicLink = {
  verifier: string;
  state: string;
  identityBase: string;
  callback: string;
  sessionEpoch: number;
  /** The shared sign-out generation; any tab's sign-out moves it. */
  signOutGeneration: number;
  pageLoad?: string;
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
      !isNumber(value.sessionEpoch) ||
      !isNumber(value.signOutGeneration)
    )
      return undefined;
    return overlapCast(value);
  } catch {
    return undefined;
  }
}

/**
 * The sign-in request to send, plus the commit that records the pending
 * link so the returning tab can be checked against the requesting one.
 */
export type MagicLinkHandoff = {
  request: RequestInit;
  commit: () => void;
};

export async function beginMagicLink(email: string): Promise<MagicLinkHandoff> {
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
    signOutGeneration: currentAuthGeneration(),
    pageLoad,
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
  // A sign-out in any tab since the link was asked for ends this request.
  const assertSignedIn = () => {
    assertCurrent();
    if (currentAuthGeneration() !== pending.signOutGeneration)
      throw new Error("You signed out after asking for this link. Ask again.");
  };
  assertSignedIn();
  // After a reload the recorded epoch is meaningless; fence the exchange to
  // the epoch it starts under, so a sign-out during it still refuses.
  const fence =
    pending.pageLoad === pageLoad
      ? pending.sessionEpoch
      : identitySessionEpoch();
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
  try {
    assertSignedIn();
  } catch (error) {
    // The exchange already issued a session: end it rather than strand it.
    const base = pending.identityBase;
    rememberBearerRevoke(body.accessToken, base);
    queueIdentityRevoke(async () => {
      await flushBearerRevokes(base);
    });
    throw error;
  }
  restoreSession(
    {
      principalId: body.principalId,
      accessToken: body.accessToken,
      issuerOrigin: new URL(pending.identityBase).origin,
    },
    fence,
    // Fence the adoption to the Identity API this link was requested from.
    pending.identityBase,
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
