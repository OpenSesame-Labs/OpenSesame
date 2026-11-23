/** Sealed file deletion under the original unlock lifetime. */
import { VfsError } from "./vfs-error.js";
import { guardedVfsWrite, originalVfsCheck } from "./vfs-operation-check.js";
import { reviseIndex } from "./vfs-sealed-index.js";
import { vfsSeams } from "./vfs-seams.js";
import { enqueueTombWrite } from "./vfs-write-order.js";

/**
 * Remove a sealed file and its index entry. The owner is rechecked at every
 * physical boundary, so a deletion queued under one unlock never lands in a
 * later one, even when that unlock reuses the same key. A key rotation within
 * the same unlock keeps it, and the index is revised under the current key.
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
  await enqueueTombWrite(tomb, async () => {
    active();
    const remove = vfsSeams.deleteOwnedFile ?? vfsSeams.deleteRawGuarded;
    const write = guardedVfsWrite();
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
}
