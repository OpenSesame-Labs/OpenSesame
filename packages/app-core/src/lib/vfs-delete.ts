/** Sealed file deletion under the original unlock lifetime. */
import { isIsolatedGuestVaultId } from "./guest-vault-id.js";
import { VfsError } from "./vfs-error.js";
import {
  beginGuestDeletion,
  deleteGuestFileInTurn,
} from "./vfs-guest-deletion.js";
import { guardedVfsWrite, originalVfsCheck } from "./vfs-operation-check.js";
import { reviseIndex } from "./vfs-sealed-index.js";
import { vfsSeams } from "./vfs-seams.js";
import { isTransientGuest } from "./vfs-transient-guest.js";
import { enqueueTombWrite } from "./vfs-write-order.js";

/** The guarded remover for this tomb: a live guest's own, or the ordinary one. */
function guardedRemove(tomb: string) {
  return isTransientGuest(tomb)
    ? (vfsSeams.guestDeleteRawGuarded ?? vfsSeams.deleteRawGuarded)
    : (vfsSeams.deleteOwnedFile ?? vfsSeams.deleteRawGuarded);
}

/**
 * Remove a sealed file and its index entry. The owner is rechecked at every
 * physical boundary, so a deletion queued under one unlock never lands in a
 * later one, even when that unlock reuses the same key. A key rotation within
 * the same unlock keeps it, and the index is revised under the current key.
 * A protected guest journals the deletion first, so a lock between the unlink
 * and the index revision is recovered before its next read or write.
 */
export async function deleteSealedFile(
  tomb: string,
  path: string,
  storageKey: string,
  currentKey: () => CryptoKey,
  owner: () => void,
): Promise<void> {
  const operation = originalVfsCheck();
  const active = () => {
    operation();
    owner();
  };
  const guest = isIsolatedGuestVaultId(tomb);
  const finish = guest ? beginGuestDeletion(tomb) : () => {};
  try {
    await enqueueTombWrite(tomb, async () => {
      active();
      if (guest && !isTransientGuest(tomb)) {
        await deleteGuestFileInTurn(tomb, path, currentKey(), active);
        return;
      }
      const remove = guardedRemove(tomb);
      const write = guardedVfsWrite(tomb);
      if (!remove || !write)
        throw new VfsError(
          "locked",
          "This storage cannot commit an original-owner deletion.",
        );
      await remove(storageKey, active);
      active();
      const key = currentKey();
      await reviseIndex(tomb, key, path, false, active, (name, value) =>
        write(name, value, active, key),
      );
      active();
    });
  } finally {
    finish();
  }
}
