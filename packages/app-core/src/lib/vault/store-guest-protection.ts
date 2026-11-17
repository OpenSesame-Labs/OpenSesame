/** Complete guest protection before publishing its durable header. */
import { revokeGuestReturns } from "../guest-return-record.js";
import { isIsolatedGuestVaultId } from "../guest-vault-id.js";
import { writeLastVaultId } from "../last-vault.js";
import type { GuestSessionPerson } from "../local-guest.js";
import { SEAL_BOUND_MARKER_PATH, writePlaintextFile } from "../vfs.js";
import { initializeGuestDeletionInTurn } from "../vfs-guest-deletion.js";
import type { TombWriteTurn } from "../vfs-write-order.js";
import { writeGuestPerson } from "./guest-person-metadata.js";
import { promoteGuestVault } from "./guest-vault-promotion.js";

export async function protectGuestTomb(input: {
  tomb: string;
  owner: symbol;
  person: GuestSessionPerson;
  key: CryptoKey;
  check: () => void;
  turn?: TombWriteTurn;
  persist: () => Promise<void>;
}): Promise<void> {
  const { tomb, owner, person, key, check, turn, persist } = input;
  await revokeGuestReturns(tomb);
  check();
  await persist();
  await writeGuestPerson(tomb, person, check, turn);
  await initializeGuestDeletionInTurn(tomb, key, check);
  await writePlaintextFile(tomb, SEAL_BOUND_MARKER_PATH, "1", check);
  await promoteGuestVault(tomb, owner, check);
  writeLastVaultId(tomb);
}

/** Whether header publication must use the isolated guest transaction. */
export function guestProtectionActive(
  ephemeral: boolean,
  tomb: string,
): boolean {
  return ephemeral && isIsolatedGuestVaultId(tomb);
}
