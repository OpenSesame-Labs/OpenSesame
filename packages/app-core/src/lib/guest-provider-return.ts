/**
 * A guest's provider flow (GitHub App, Vercel Connect) returns to the guest
 * that started it. A temporary guest lives only in this document, so it
 * connects through a pop-up; a full navigation needs a protected vault that
 * survives the reload. Any lock, other guest, or sign-out in any tab ends it.
 */
import { atRestSettled } from "./at-rest/key.js";
import {
  activeGuestEpoch,
  captureGuestSessionContext,
  isLocalOnlyGuest,
} from "./guest-session-context.js";
import { isGuestVaultId } from "./guest-vault-id.js";
import { vaultStore } from "./vault/store.js";

export const GUEST_LOCAL_ONLY =
  "This vault is local only. Sign out and start a new guest session to connect services.";

/** Capture the guest that starts a provider flow, before opening a popup. */
export function captureGuestProviderAttempt(): () => void {
  const snapshot = vaultStore.getSnapshot();
  if (!snapshot.guest && !isGuestVaultId(snapshot.tomb)) return () => {};
  if (isLocalOnlyGuest()) throw new Error(GUEST_LOCAL_ONLY);
  if (snapshot.prefs.lockOnHide)
    throw new Error(
      "Turn off Lock when hidden before connecting, then try again.",
    );
  const current = captureGuestSessionContext();
  if (!current?.()) throw new Error("The guest session ended. Connect again.");
  if (activeGuestEpoch() === null)
    throw new Error(
      "This browser cannot verify the guest session. Enable persistent storage and try again.",
    );
  return () => {
    if (!current()) throw new Error("The guest session ended. Connect again.");
  };
}

/** Full-page navigation away from a guest must be able to come back to it. */
export function assertGuestNavigationCanResume(): void {
  const snapshot = vaultStore.getSnapshot();
  const guestVault = snapshot.guest || isGuestVaultId(snapshot.tomb);
  if (guestVault && snapshot.prefs.lockOnHide)
    throw new Error(
      "Turn off Lock when hidden before connecting, then try again.",
    );
  if (snapshot.guest)
    throw new Error(
      "Protect this vault before opening the provider in this tab.",
    );
  if (guestVault && (!snapshot.durable || atRestSettled()?.durable !== true))
    throw new Error(
      "This browser cannot keep the guest vault after navigation. Allow pop-ups or use a browser with persistent storage.",
    );
}

/** Popups return to the still-open guest; full navigation requires a protected vault. */
export async function prepareGuestProviderReturn(
  kind: "github" | "vercel",
  _token: string,
  returnUrl: string,
): Promise<string> {
  if (kind === "github") assertGuestNavigationCanResume();
  const snapshot = vaultStore.getSnapshot();
  if (snapshot.guest || isGuestVaultId(snapshot.tomb))
    captureGuestProviderAttempt()();
  return returnUrl;
}
