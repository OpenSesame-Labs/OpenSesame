/** Capture transport identity and select guarded writes; supplies no authority. */
import { vfsSeams } from "./vfs-seams.js";

/** The guarded writer for ordinary VFS metadata, or none when the transport has none. */
export function guardedVfsWrite() {
  return vfsSeams.writeRawGuarded ?? vfsSeams.writeOwnedMetadata;
}

const TRANSPORT_FIELDS = [
  "readRaw",
  "writeRaw",
  "writeRawGuarded",
  "writeOwnedMetadata",
  "writeOwnedBody",
  "deleteRaw",
  "deleteRawGuarded",
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
