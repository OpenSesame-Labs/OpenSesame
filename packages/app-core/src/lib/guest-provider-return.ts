import { atRestSettled } from "./at-rest/key.js";
import { guestReturnGeneration } from "./guest-return-record.js";
import { captureGuestReturnSignOutCheck } from "./guest-return-signout.js";
import {
  activeGuestEpoch,
  captureGuestSessionContext,
  isLocalOnlyGuest,
} from "./guest-session-context.js";
import { isGuestVaultId } from "./guest-vault-id.js";
import { vaultStore } from "./vault/store.js";

/** Capture the guest that starts a provider flow, before opening a popup. */
export function captureGuestProviderAttempt(): () => void {
  const snapshot = vaultStore.getSnapshot();
  if (!snapshot.guest && !isGuestVaultId(snapshot.tomb)) return () => {};
  if (isLocalOnlyGuest())
    throw new Error(
      "This vault is local only. Sign out and start a new guest session to connect services.",
    );
  if (snapshot.prefs.lockOnHide)
    throw new Error(
      "Turn off Lock when hidden before connecting, then try again.",
    );
  const signOutCheck = captureGuestReturnSignOutCheck();
  const current = captureGuestSessionContext();
  const generation = guestReturnGeneration(snapshot.tomb);
  if (!current?.()) throw new Error("The guest session ended. Connect again.");
  if (activeGuestEpoch() === null)
    throw new Error(
      "This browser cannot verify the guest session. Enable persistent storage and try again.",
    );
  return () => {
    signOutCheck();
    if (!current() || guestReturnGeneration(snapshot.tomb) !== generation)
      throw new Error("The guest session ended. Connect again.");
  };
}

export function assertGuestNavigationCanResume(): void {
  const snapshot = vaultStore.getSnapshot();
  if (
    (snapshot.guest || isGuestVaultId(snapshot.tomb)) &&
    snapshot.prefs.lockOnHide
  )
    throw new Error(
      "Turn off Lock when hidden before connecting, then try again.",
    );
  if (snapshot.guest)
    throw new Error(
      "Protect this vault before opening the provider in this tab.",
    );
  if (
    (snapshot.guest || isGuestVaultId(snapshot.tomb)) &&
    (!snapshot.durable || atRestSettled()?.durable !== true)
  )
    throw new Error(
      "This browser cannot keep the guest vault after navigation. Allow pop-ups or use a browser with persistent storage.",
    );
}

/** An unprotected guest exists only in this document and cannot survive navigation. */
export function assertGuestVercelNavigationCanResume(_token?: string): void {
  assertGuestNavigationCanResume();
}

/** Popups return to the still-open guest; full navigation requires a protected vault. */
export async function prepareGuestProviderReturn(
  kind: "github" | "vercel",
  _token: string,
  returnUrl: string,
  _connectionId?: string,
): Promise<string> {
  if (kind === "github") assertGuestNavigationCanResume();
  const snapshot = vaultStore.getSnapshot();
  if (snapshot.guest || isGuestVaultId(snapshot.tomb))
    captureGuestProviderAttempt()();
  return returnUrl;
}
