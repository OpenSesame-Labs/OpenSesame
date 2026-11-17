/** Sealed file deletion, with original-owner recovery for isolated guests. */
import { isIsolatedGuestVaultId } from "./guest-vault-id.js";
import { VfsError } from "./vfs-error.js";
import {
  beginGuestDeletion,
  deleteGuestFileInTurn,
} from "./vfs-guest-deletion.js";
import { guardedVfsWrite, originalVfsCheck } from "./vfs-operation-check.js";
import { reviseIndex } from "./vfs-sealed-index.js";
import { vfsSeams } from "./vfs-seams.js";
import { tombFileKey } from "./vfs-storage-key.js";
import { isTransientGuest } from "./vfs-transient-guest.js";
import { enqueueTombWrite } from "./vfs-write-order.js";

type Owner = Readonly<{ key: CryptoKey; check: () => void }>;
type Keys = { current: () => Owner | undefined; required: () => Owner };

async function deleteTransientGuest(
  tomb: string,
  path: string,
  key: CryptoKey,
  active: () => void,
): Promise<void> {
  const remove = vfsSeams.guestDeleteRawGuarded ?? vfsSeams.deleteRawGuarded;
  const write =
    vfsSeams.guestWriteRawGuarded ??
    vfsSeams.writeRawGuarded ??
    vfsSeams.writeOwnedMetadata;
  if (!remove || !write)
    throw new VfsError(
      "locked",
      "This storage cannot commit an original-owner deletion.",
    );
  await remove(tombFileKey(tomb, path), active);
  active();
  await reviseIndex(tomb, key, path, false, active, (name, value) =>
    write(name, value, active, key),
  );
  active();
}

export async function deleteSealedFile(
  tomb: string,
  path: string,
  keys: Keys,
): Promise<void> {
  const owner = keys.current();
  if (!owner) {
    if (vfsSeams.readRaw(tombFileKey(tomb, path)) !== null) keys.required();
    return;
  }
  const operation = originalVfsCheck();
  const active = () => {
    operation();
    owner.check();
  };
  const guest = isIsolatedGuestVaultId(tomb);
  const finish = guest ? beginGuestDeletion(tomb) : () => {};
  try {
    await enqueueTombWrite(tomb, async () => {
      const storageKey = tombFileKey(tomb, path);
      active();
      if (!guest) {
        const remove = vfsSeams.deleteOwnedFile ?? vfsSeams.deleteRawGuarded;
        const write = guardedVfsWrite(tomb);
        if (!remove || !write)
          throw new VfsError(
            "locked",
            "This storage cannot commit an original-owner deletion.",
          );
        await remove(storageKey, active);
        active();
        await reviseIndex(tomb, owner.key, path, false, active, (name, value) =>
          write(name, value, active, owner.key),
        );
        active();
        return;
      }
      if (isTransientGuest(tomb))
        await deleteTransientGuest(tomb, path, owner.key, active);
      else await deleteGuestFileInTurn(tomb, path, owner.key, active);
    });
  } finally {
    finish();
  }
}
