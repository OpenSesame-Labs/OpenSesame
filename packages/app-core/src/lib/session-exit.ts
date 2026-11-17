/**
 * The roads out of an account, and the one back in as somebody else.
 *
 * A device holds two separate ledgers: who is signed in (the Identity session
 * and the upstream assertion federation saved), and which key opens a vault.
 * Locking ends only the second. Nothing ended the first from inside the app —
 * the only sign-out was a link on the unlock screen's Sign in tab, and it
 * revoked the Identity session while leaving the shoo.dev assertion in web
 * storage, so the device still counted as signed in on the next load.
 *
 * `signOut` ends the first ledger whole and locks the second: there is no
 * reading of "sign out" under which the vault should stay open for whoever
 * is at the keyboard next. `switchAccount` is the same exit with the next
 * sign-in armed to ask the issuer afresh; `attachAccount` keeps the session
 * and asks the unlock screen's sign-in panel for another identity to link to it.
 *
 * Every one of these lands on the unlock screen's sign-in panel, which reads
 * the stored outcome and says what just happened (`PendingLinkBanner`).
 */

import { host } from "../host.js";
import { originFiles } from "../ports.js";
import { ambientAuthSeams } from "./ambient-auth-seam.js";
import { clearAuthOutcome, storeAuthOutcome } from "./auth-outcome.js";
import { forgetClaim } from "./claims/arrival.js";
import { clearSession as clearFederationSession } from "./federation.js";
import { clearPendingSignIn } from "./federation-pending.js";
import { forgetPendingLink } from "./guest-auth.js";
import { inspectStoredGuestContinuation } from "./guest-continuation.js";
import { markGuestSignOutBarrier } from "./guest-return-barrier.js";
import { advanceGuestReturnEpoch } from "./guest-return-epoch.js";
import {
  guestReturnSignOutPending,
  guestReturnSignOutSnapshot,
  restoreGuestReturnSignOut,
  retryGuestReturnSignOut,
  stageGuestReturnSignOut,
} from "./guest-return-signout.js";
import { endSession, isRemoteIdentityConfigured } from "./identity.js";
import { endJoinAuthority } from "./join/client.js";
import { clearPendingJoin } from "./join/stash.js";
import { dismissNotice, setStatusNotice } from "./notices.js";
import {
  deferRemoteSignOut,
  finishLocalGuestCleanup,
} from "./session-exit-remote.js";
import { emitVaultLock } from "./vault/lock-events.js";
import { vaultStore } from "./vault/store.js";

/**
 * Sign out of this device: forget the upstream assertion, revoke the Identity
 * session (bearer and HttpOnly cookie), drop any link waiting on an unlock
 * and any join waiting on a code, and lock the vault.
 *
 * Order matters. The vault locks last so that lock handlers — which may
 * themselves call `endSession` under the strict preference — find nothing
 * left to end, and the outcome is stored before the lock so the unlock
 * screen that mounts on lock already knows why it is there.
 */
/** Whether this sign-out is the first half of "switch account". */
type SignOutIntent = "leave" | "switch";
let signOutGeneration = 0;

function signOutDefault(intent: SignOutIntent = "leave"): void {
  const generation = ++signOutGeneration;
  restoreGuestReturnSignOut();
  const inspected = inspectStoredGuestContinuation();
  const guestReturn = inspected.kind === "present" ? inspected.value : null;
  if (guestReturn) stageGuestReturnSignOut(guestReturn, intent === "switch");
  let incomplete = inspected.kind === "unavailable";
  if (incomplete) markGuestSignOutBarrier(true);
  const attempt = (action: () => void) => {
    try {
      action();
    } catch {
      incomplete = true;
      markGuestSignOutBarrier(true);
    }
  };
  // Returns issued in any document must be invalidated even when this tab
  // cannot see their session-storage continuations.
  attempt(() => {
    if (originFiles() || host().storage?.local) advanceGuestReturnEpoch();
  });
  attempt(ambientAuthSeams.fenceLocalSignOut);
  attempt(ambientAuthSeams.cancelAllTransactions);
  attempt(clearFederationSession);
  attempt(clearPendingSignIn);
  attempt(forgetPendingLink);
  attempt(clearPendingJoin);
  attempt(endJoinAuthority);
  attempt(forgetClaim);
  clearAuthOutcome();
  attempt(() => endSession({ orphan: isRemoteIdentityConfigured() }));
  attempt(() => {
    if (
      vaultStore.isUnlocked() ||
      vaultStore.getSnapshot().awaitingSecondStep
    ) {
      vaultStore.lock();
    } else emitVaultLock();
  });
  finishSignOut(incomplete, Boolean(guestReturn), intent, generation);
}

function finishSignOut(
  incomplete: boolean,
  hasGuestReturn: boolean,
  intent: SignOutIntent,
  generation: number,
): void {
  if (
    !incomplete &&
    deferRemoteSignOut(
      () => generation === signOutGeneration,
      (failed) => {
        if (failed) markGuestSignOutBarrier(true);
        finishSignOut(failed, hasGuestReturn, intent, generation);
      },
    )
  ) {
    return;
  }
  if (!incomplete) incomplete = !finishLocalGuestCleanup(hasGuestReturn);
  if (incomplete) {
    clearAuthOutcome();
    setStatusNotice({
      id: "session.signout-incomplete",
      tone: "err",
      title: "Sign-out incomplete",
      body: "Check your connection and browser storage, then try signing out again.",
      retry: () => signOutDefault(intent),
      transient: true,
    });
  } else {
    dismissNotice("session.signout-incomplete");
    if (!hasGuestReturn && !guestReturnSignOutSnapshot())
      storeAuthOutcome(
        intent === "switch"
          ? { kind: "signed_out", switching: true }
          : { kind: "signed_out" },
      );
  }
  if (hasGuestReturn || guestReturnSignOutPending()) retryGuestReturnSignOut();
}

/**
 * Sign out, then let the person sign in as somebody else. The next sign-in
 * carries `prompt=login` on every OIDC issuer; shoo.dev has no such flag and
 * answers with the Google account it remembers (see `BeginSignInOptions`).
 */
function switchAccountDefault(): void {
  signOutDefault("switch");
}

/**
 * Attach another identity to the account this device already has. The
 * session stays; the vault locks, because the sign-in panel — the one surface
 * that offers every configured way in — lives on the unlock screen, and the
 * returning leg links the new identity to the principal that is still signed
 * in (`adoptFederatedIdentity`).
 */
function attachAccountDefault(): void {
  signOutGeneration += 1;
  storeAuthOutcome({ kind: "attach" });
  if (vaultStore.isUnlocked()) vaultStore.lock();
}

export const sessionExitSeams = {
  signOut: signOutDefault,
  switchAccount: switchAccountDefault,
  attachAccount: attachAccountDefault,
};

export function signOut(): void {
  sessionExitSeams.signOut();
}

export function switchAccount(): void {
  sessionExitSeams.switchAccount();
}

export function attachAccount(): void {
  sessionExitSeams.attachAccount();
}
