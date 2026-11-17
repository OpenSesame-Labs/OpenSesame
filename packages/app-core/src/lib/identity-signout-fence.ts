/** Refuse remote Identity work while a shared sign-out is unresolved. */
import { guestSignOutBarrierActive } from "./guest-return-barrier.js";
import { hasPendingBoundRevocation } from "./identity-revocation-journal.js";
import { identityRevocationPending as queuePending } from "./identity-revocation-queue.js";
import { IdentityError } from "./identity-session-types.js";

export function assertNoPendingSignOut(): void {
  if (hasPendingBoundRevocation() || guestSignOutBarrierActive())
    throw new IdentityError("Finish signing out before signing in again.", 409);
}

export function signOutFenceActive(): boolean {
  try {
    assertNoPendingSignOut();
    return false;
  } catch {
    return true;
  }
}

export function identityRevocationPending(): boolean {
  if (queuePending()) return true;
  try {
    return hasPendingBoundRevocation();
  } catch {
    return true;
  }
}
