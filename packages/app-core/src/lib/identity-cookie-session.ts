import { isString, overlapCast } from "@opensesame/os-domain";
import {
  identityPlaneRequest,
  isDeviceIdentityMode,
} from "./device-identity.js";
import { readCookieBinding } from "./identity-cookie-binding.js";
import {
  IdentityError,
  type IdentitySession,
} from "./identity-session-types.js";

/** Read the cookie only while the caller's original session is current. */
export async function readCookieSession(
  issuerOrigin: string,
  current: () => boolean,
): Promise<IdentitySession | null> {
  if (isDeviceIdentityMode()) return null;
  const binding = readCookieBinding(issuerOrigin);
  if (!binding) return null;
  const check = () => {
    if (!current())
      throw new IdentityError(
        "The session ended while it was being restored.",
        409,
      );
  };
  try {
    const res = await identityPlaneRequest("/v1/bound/principals/me", {
      credentials: "include",
      headers: {
        "x-opensesame-session-id": binding.sessionId,
        "x-opensesame-session-proof": binding.proof,
        "x-opensesame-principal-id": binding.principalId,
      },
      timeoutMs: 4000,
    });
    check();
    if (!res.ok || res.headers.get("x-opensesame-cookie-bound") !== "1")
      return null;
    const body = overlapCast(await res.json());
    check();
    if (!isString(body.id) || body.id !== binding.principalId) return null;
    return {
      principalId: binding.principalId,
      accessToken: `cookie:${binding.principalId}`,
      cookieOnly: true,
      issuerOrigin,
    };
  } catch {
    check();
    return null;
  }
}
