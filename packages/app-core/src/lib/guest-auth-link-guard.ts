/** Retire a linked token before releasing the browser cookie lock on failure. */
import { resolveIdentityBase } from "./device-identity.js";
import { markGuestSignOutBarrier } from "./guest-return-barrier.js";
import { clearSession, currentSession } from "./identity.js";
import {
  identityOriginFor,
  revokeRequest,
} from "./identity-cookie-transport.js";
import { queueIssuerRevocation } from "./identity-revocation-queue.js";

export async function commitGuestLink(
  token: string,
  issuer: string,
  check: () => void,
  commit: () => Promise<void>,
): Promise<void> {
  try {
    check();
    await commit();
    check();
  } catch (error) {
    if (currentSession()?.accessToken === token) clearSession();
    const currentIssuer = () => identityOriginFor(resolveIdentityBase);
    try {
      if (!issuer || currentIssuer() !== issuer)
        throw new Error("Identity changed.");
      const response = await revokeRequest(token, "omit");
      if (!response.ok) throw new Error("Identity refused sign-out.");
    } catch {
      markGuestSignOutBarrier(true);
      queueIssuerRevocation(issuer, currentIssuer, () =>
        revokeRequest(token, "omit"),
      );
    }
    throw error;
  }
}
