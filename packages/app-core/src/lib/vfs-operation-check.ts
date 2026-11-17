/** Capture transport identity and select guarded writes; supplies no authority. */
import { vfsSeams } from "./vfs-seams.js";
import { isTransientGuest } from "./vfs-transient-guest.js";

export function guardedVfsWrite(tomb: string) {
  return (
    (isTransientGuest(tomb) ? vfsSeams.guestWriteRawGuarded : undefined) ??
    vfsSeams.writeRawGuarded ??
    vfsSeams.writeOwnedMetadata
  );
}
const TRANSPORT_FIELDS = [
  "readRaw",
  "writeRaw",
  "writeRawGuarded",
  "guestWriteRawGuarded",
  "writeOwnedMetadata",
  "writeOwnedBody",
  "deleteRaw",
  "deleteRawGuarded",
  "guestDeleteRawGuarded",
  "deleteOwnedFile",
  "openBody",
  "refreshRaw",
  "authenticationStorage",
  "open",
  "seal",
] as const;

export function originalVfsCheck(check?: () => void): () => void {
  const captured = TRANSPORT_FIELDS.map((field) => vfsSeams[field]);
  const active = () => {
    check?.();
    if (
      TRANSPORT_FIELDS.some(
        (field, index) => vfsSeams[field] !== captured[index],
      )
    )
      throw new Error("Original vault transport changed.");
  };
  active();
  return active;
}
