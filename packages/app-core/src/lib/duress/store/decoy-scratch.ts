/**
 * Where a duress decoy runs when the guest tomb already holds a sealed vault
 * of its own — a guest who enrolled a PIN, a password or a passkey.
 *
 * A decoy is a fresh, guest-looking session. It must never destroy a sealed
 * vault, so beside a sealed guest it runs in a scratch tomb instead of wiping
 * `GUEST_TOMB`. The scratch tomb is never a project, presents as the guest
 * road, and is erased when the session ends.
 */

import { isGuestVaultId } from "../../guest-vault-id.js";
import { headerCarriesGate } from "../../vault/header-gate.js";
import { readTombHeader } from "../../vault/store-header.js";
import { ATTEMPTS_KEY, type VaultScope } from "../../vault/store-scope.js";
import {
  discardVaultBody,
  wipeTombOnDestroy,
} from "../../vault/tomb-migration.js";
import { GUEST_TOMB, unregisterTomb } from "../../vfs.js";

/** Plaintext name only; nothing in it says what the session was. */
export const DECOY_SCRATCH_TOMB = "guest-scratch";

/** True when the guest tomb carries its own key (a vault a decoy must not wipe). */
export function guestTombIsSealed(): boolean {
  return headerCarriesGate(readTombHeader(GUEST_TOMB));
}

/**
 * The scratch scope. Its lockout counter is its own: deleting the decoy clears
 * that counter, and must never reset the sealed guest's.
 */
export function decoyScratchScope(): VaultScope {
  return {
    tomb: DECOY_SCRATCH_TOMB,
    attempts: `${ATTEMPTS_KEY}.${DECOY_SCRATCH_TOMB}`,
  };
}

/** The guest isolation tomb or the decoy's stand-in for it. */
export function isGuestSessionTomb(tomb: string | null): boolean {
  return isGuestVaultId(tomb) || tomb === DECOY_SCRATCH_TOMB;
}

let decoySession = false;

/** True while the open session is a duress decoy (guest in isolation, drawn as the vault). */
export function isDecoySession(): boolean {
  return decoySession;
}

/** Mark or end the decoy session; answers what it was, so a lock can hand back. */
export function markDecoySession(on: boolean): boolean {
  const was = decoySession;
  decoySession = on;
  return was;
}

/** The road a tomb presents as (display only): the scratch tomb reads as guest. */
export function presentedTomb(tomb: string): string {
  return tomb === DECOY_SCRATCH_TOMB ? GUEST_TOMB : tomb;
}

/** Retire the scratch registry entry under the shared registry lock. */
export async function forgetDecoyScratch(tomb: string): Promise<void> {
  if (tomb !== DECOY_SCRATCH_TOMB) return;
  await unregisterTomb(tomb);
}

/** End an ephemeral session's tomb: the scratch tomb goes whole, guest keeps its wipe. */
export async function endEphemeralTomb(tomb: string): Promise<void> {
  if (tomb !== DECOY_SCRATCH_TOMB) {
    await wipeTombOnDestroy(tomb);
    return;
  }
  // Discard refreshes the shared index; finish before the wipe removes it.
  await discardVaultBody(tomb);
  await wipeTombOnDestroy(tomb);
  await forgetDecoyScratch(tomb);
}
