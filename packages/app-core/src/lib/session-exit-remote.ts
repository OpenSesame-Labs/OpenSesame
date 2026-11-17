/** Wait for the exact sign-out's remote revocations before publishing success. */
import { loadSession as loadFederationSession } from "./federation.js";
import { federationSessionGeneration } from "./federation-native-session.js";
import {
  clearGuestSignOutBarrier,
  completeGuestSignOutCleanup,
} from "./guest-return-barrier.js";
import {
  guestReturnSignOutPending,
  restoreGuestReturnSignOut,
} from "./guest-return-signout.js";
import {
  currentSession,
  identityRevocationPending,
  identitySessionEpoch,
  identitySessionRevision,
  settleRevokes,
} from "./identity.js";

export function finishLocalGuestCleanup(hasGuestReturn: boolean): boolean {
  if (!completeGuestSignOutCleanup()) return false;
  if (hasGuestReturn || guestReturnSignOutPending()) return true;
  if (!clearGuestSignOutBarrier()) return false;
  restoreGuestReturnSignOut();
  return true;
}

export function deferRemoteSignOut(
  isCurrent: () => boolean,
  finish: (failed: boolean) => void,
): boolean {
  if (!identityRevocationPending()) return false;
  const epoch = identitySessionEpoch();
  const revision = identitySessionRevision();
  const federation = federationSessionGeneration();
  void settleRevokes().then(
    () => {
      if (
        !isCurrent() ||
        identitySessionEpoch() !== epoch ||
        identitySessionRevision() !== revision ||
        federationSessionGeneration() !== federation ||
        currentSession() ||
        loadFederationSession()
      )
        return;
      finish(false);
    },
    () => {
      if (isCurrent()) finish(true);
    },
  );
  return true;
}
