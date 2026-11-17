import type { readCookieBinding } from "./identity-cookie-binding.js";
import {
  revokeBoundCookie,
  revokeObservedCookie,
  revokeRequest,
} from "./identity-cookie-transport.js";

/** Revoke the captured session and then every observable browser cookie. */
export async function revokeIdentitySession(input: {
  bound: ReturnType<typeof readCookieBinding>;
  bearer: string | undefined;
  issuer: string;
  orphan: boolean;
  currentIssuer: () => string;
}): Promise<Response> {
  const { bound, bearer, issuer, orphan, currentIssuer } = input;
  const check = () => {
    if (currentIssuer() !== issuer)
      throw new Error("Identity configuration changed during sign-out.");
  };
  let boundRevoked = false;
  if (bound) {
    const result = await revokeBoundCookie(bound);
    check();
    boundRevoked = result.ok;
    if (!result.ok && !bearer) return result;
    if (result.ok && !orphan) return result;
  }
  if (bearer && !boundRevoked) {
    const result = await revokeRequest(bearer, "omit");
    check();
    if (!result.ok || !orphan) return result;
  }
  return revokeObservedCookie(check);
}
