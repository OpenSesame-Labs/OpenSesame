/** Capture revocation authority before ending the current in-memory session. */

import { markGuestSignOutBarrier } from "./guest-return-barrier.js";
import {
  type CookieBinding,
  clearMatchingCookieBinding,
  inspectCookieBinding,
} from "./identity-cookie-binding.js";
import { revokeRequest } from "./identity-cookie-transport.js";
import { advanceIdentityEpoch } from "./identity-owner-epoch.js";
import { stageBoundRevocation } from "./identity-revocation-journal.js";
import { queueBoundRevocation } from "./identity-revocation-journal-queue.js";
import {
  queueIssuerRevocation,
  retryIdentityRevocations,
} from "./identity-revocation-queue.js";
import type { IdentitySession } from "./identity-session-types.js";
import { revokeIdentitySession } from "./identity-signout-request.js";

function bindingForSignOut(
  issuer: string,
  session: IdentitySession | null,
): CookieBinding | null {
  const inspected = inspectCookieBinding(issuer);
  if (inspected.kind === "unavailable")
    throw new Error("The previous sign-in could not be verified.");
  const candidate = inspected.kind === "present" ? inspected.value : null;
  if (candidate && session && candidate.principalId !== session.principalId)
    throw new Error("The previous sign-in does not match this session.");
  return candidate;
}

export function endIdentitySession(input: {
  session: IdentitySession | null;
  issuer: string;
  currentIssuer: () => string;
  orphan: boolean;
  clear: () => void;
  failed: () => Promise<void>;
}): void {
  const { session, issuer, currentIssuer, orphan, clear, failed } = input;
  const bearer =
    session && !session.cookieOnly && session.issuerOrigin === currentIssuer()
      ? session.accessToken
      : undefined;
  let bound: CookieBinding | null = null;
  let staged: ReturnType<typeof stageBoundRevocation> | null = null;
  try {
    bound = bindingForSignOut(issuer, session);
    if (bound || bearer || orphan) advanceIdentityEpoch();
    if (bound) staged = stageBoundRevocation(bound, orphan);
  } catch (error) {
    // Lock locally, but retain the original proof so sign-out can be retried.
    markGuestSignOutBarrier(true);
    if (bearer)
      queueIssuerRevocation(issuer, currentIssuer, () =>
        revokeRequest(bearer, "omit"),
      );
    clear();
    throw error;
  }
  if (bound) clearMatchingCookieBinding(bound);
  clear();
  retryIdentityRevocations();
  if (staged) {
    queueBoundRevocation(staged, currentIssuer, failed, bearer);
    return;
  }
  if (!bearer && !bound && !orphan) return;
  queueIssuerRevocation(
    issuer,
    currentIssuer,
    () =>
      revokeIdentitySession({ bound, bearer, issuer, orphan, currentIssuer }),
    failed,
    orphan,
  );
}
