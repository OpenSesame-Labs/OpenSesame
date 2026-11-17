/** Keep temporary guest ciphertext in this document even with a file backend. */
import type { VfsSeams } from "../vfs-seams.js";
import {
  deleteTransientGuest,
  isReadableTransientGuestKey,
  isTransientGuest,
  isTransientGuestKey,
  readTransientGuest,
  writeTransientGuest,
} from "../vfs-transient-guest.js";
import type { FileBackedVfs } from "./vfs-files.js";

export function withTransientGuest(
  seams: FileBackedVfs["seams"],
): Partial<VfsSeams> {
  return {
    authenticationStorage: "file-backed",
    readRaw: (key) =>
      isReadableTransientGuestKey(key)
        ? readTransientGuest(key)
        : seams.readRaw(key),
    writeRaw: async (key, value, vaultKey) => {
      if (isTransientGuestKey(key) && (await writeTransientGuest(key, value)))
        return;
      await seams.writeRaw(key, value, vaultKey);
    },
    guestWriteRawGuarded: async (key, value, check) => {
      if (
        isTransientGuestKey(key) &&
        (await writeTransientGuest(key, value, check))
      )
        return;
      throw new Error("The guest session has ended.");
    },
    deleteRaw: async (key) => {
      if (isTransientGuestKey(key) && (await deleteTransientGuest(key))) return;
      await seams.deleteRaw(key);
    },
    guestDeleteRawGuarded: async (key, check) => {
      if (isTransientGuestKey(key) && (await deleteTransientGuest(key, check)))
        return;
      throw new Error("This storage cannot commit an original-owner deletion.");
    },
    openBody: (tomb, key, check) =>
      isTransientGuest(tomb)
        ? Promise.resolve()
        : seams.openBody(tomb, key, check),
  };
}
