/** Route a request through a verified tab binding or its explicit bearer. */

import { lockManager } from "../ports.js";
import { identityPlaneRequest } from "./device-identity.js";
import { readCookieBinding } from "./identity-cookie-binding.js";
import {
  assertIdentityEpoch,
  captureIdentityEpoch,
} from "./identity-owner-epoch.js";
import {
  IdentityError,
  type IdentitySession,
} from "./identity-session-types.js";
import { assertNoPendingSignOut } from "./identity-signout-fence.js";

function bindRequest(
  path: string,
  active: IdentitySession | null,
  headers: Headers,
) {
  const binding = active ? readCookieBinding(active.issuerOrigin) : null;
  const bound = Boolean(
    active?.cookieOnly ||
      (active && binding && path === "/v1/principals/link-identities"),
  );
  if (!bound || !active) return { target: path, bound: false };
  if (
    !binding ||
    binding.principalId !== active.principalId ||
    !path.startsWith("/v1/")
  )
    throw new IdentityError("Sign in again to continue this session.", 401);
  headers.set("x-opensesame-session-id", binding.sessionId);
  headers.set("x-opensesame-session-proof", binding.proof);
  headers.set("x-opensesame-principal-id", binding.principalId);
  return { target: `/v1/bound/${path.slice(4)}`, bound: true };
}

export async function fetchIdentity(
  path: string,
  init: RequestInit,
  active: IdentitySession | null,
  unauthorized: () => void,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (active && !active.cookieOnly)
    headers.set("authorization", `Bearer ${active.accessToken}`);
  if (init.body && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  const { target, bound } = bindRequest(path, active, headers);
  const response = await identityPlaneRequest(target, {
    ...init,
    headers,
    credentials: bound ? "include" : "omit",
    timeoutMs: 8000,
  });
  if (bound && response.headers.get("x-opensesame-cookie-bound") !== "1") {
    unauthorized();
    throw new IdentityError("Sign in again to continue this session.", 401);
  }
  if (response.status === 401 && active) unauthorized();
  return response;
}

/** Do not dispatch or publish an Identity response across a sign-out fence. */
export async function guardedIdentityFetch(
  path: string,
  init: RequestInit,
  current: () => IdentitySession | null,
  unauthorized: () => void,
): Promise<Response> {
  const run = async () => {
    assertNoPendingSignOut();
    const epoch = captureIdentityEpoch();
    const original = current();
    const response = await fetchIdentity(path, init, original, unauthorized);
    assertIdentityEpoch(epoch);
    assertNoPendingSignOut();
    if (original && response.status !== 401 && current() !== original)
      throw new IdentityError("The session ended during the request.", 409);
    return response;
  };
  // Revocation takes this same lock exclusively. A request already on the
  // wire therefore settles before sign-out can revoke and report completion;
  // it cannot perform a late server mutation after the user has signed out.
  const locks = lockManager();
  return locks
    ? locks.request(
        "opensesame:identity-cookie-session",
        { mode: "shared" },
        run,
      )
    : run();
}
