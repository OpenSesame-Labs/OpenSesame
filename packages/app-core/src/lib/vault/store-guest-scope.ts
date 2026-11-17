import { endEphemeralTomb } from "../duress/store/decoy-scratch.js";
import {
  lastGuestVaultId,
  lastVaultIsGuest,
  writeLastVaultId,
} from "../last-vault.js";
import { GUEST_TOMB } from "../vfs.js";
import { endTransientGuest } from "../vfs-transient-guest.js";
import { trackVfsCleanup } from "../vfs-write-order.js";
import { guestVaultScope, scopedVaultScope } from "./store-scope.js";

/** Restore the selected account after an ephemeral guest or decoy locks. */
export function guestScopeAfterLock(
  ephemeralTomb: string | null,
  wasDecoy: boolean,
  record: boolean,
) {
  const toGuest = !wasDecoy || lastVaultIsGuest();
  const guestTomb = wasDecoy ? (lastGuestVaultId() ?? GUEST_TOMB) : GUEST_TOMB;
  if (record && toGuest) writeLastVaultId(guestTomb);
  return {
    scope: toGuest ? guestVaultScope(guestTomb) : scopedVaultScope(),
    clearHeader: toGuest && ephemeralTomb === guestTomb,
  };
}

/** Retire temporary guest storage after locking its vault. */
export function retireEphemeralStorage(
  tomb: string | null,
  owner: symbol | null,
): void {
  if (tomb && owner) endTransientGuest(tomb, owner);
  else if (tomb) trackVfsCleanup(endEphemeralTomb(tomb));
}
