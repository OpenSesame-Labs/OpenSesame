/** Existing synthetic/guest-only creation data. Cannot produce a real principal. */
import { type VaultHeader, mintVaultKey } from "@opensesame/vault-core";
import {
  decoyScratchScope,
  forgetDecoyScratch,
  guestTombIsSealed,
  isGuestSessionTomb,
  markDecoySession,
} from "../duress/store/decoy-scratch.js";
import { clearGuestConnections } from "../guest-connections.js";
import { writeLastVaultId } from "../last-vault.js";
import { GUEST_TOMB, lockTomb } from "../vfs.js";
import { guestVaultScope } from "./store-scope.js";
import { discardVaultBody, wipeTombOnDestroy } from "./tomb-migration.js";
export type GuestCreationOptions = {
  resume?: boolean;
  decoy?: boolean;
  scratch?: true;
};

/** A new guest must never replace a guest vault that has an enrolled key. */
export function assertGuestVaultAvailable(): void {
  if (guestTombIsSealed()) {
    throw new Error("Unlock the protected guest vault before continuing.");
  }
}

export function selectGuestScope(options?: GuestCreationOptions) {
  // A duress decoy uses scratch beside a protected guest. Ordinary guest entry
  // must refuse rather than overwrite that vault or create an unopenable one.
  markDecoySession(options?.decoy === true);
  if (!options?.decoy) assertGuestVaultAvailable();
  const scratch =
    options?.decoy === true &&
    (options.scratch === true || guestTombIsSealed());
  return scratch ? decoyScratchScope() : guestVaultScope();
}
export async function prepareGuestMaterial(
  tomb: string,
  options?: GuestCreationOptions,
) {
  if (!isGuestSessionTomb(tomb))
    throw new Error("Guest material requires an isolated tomb.");
  // Fresh Continue-as-guest drops prior claims; unlock/resume keeps them (GitHub App return).
  if (!options?.resume && tomb === GUEST_TOMB) clearGuestConnections();
  forgetDecoyScratch(tomb);
  // A previous guest's leftovers are ciphertext under a dead tab's key — unreadable, in the way.
  lockTomb(tomb);
  await wipeTombOnDestroy(tomb);
  await discardVaultBody(tomb);
  const { vaultKey, rawVaultKey } = await mintVaultKey();
  const header: VaultHeader = { v: 1, createdAt: new Date().toISOString() };
  return { header, vaultKey, rawVaultKey };
}

export function recordGuestOrigin(options?: GuestCreationOptions): void {
  // A decoy leaves the unlock screen on the vault it was typed at.
  if (!options?.decoy) writeLastVaultId(GUEST_TOMB);
}
