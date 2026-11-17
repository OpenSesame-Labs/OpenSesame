/** Plaintext VFS metadata: public header parameters and migration markers. */
import { isIsolatedGuestVaultId } from "./guest-vault-id.js";
import { VfsError } from "./vfs-error.js";
import { guardedVfsWrite, originalVfsCheck } from "./vfs-operation-check.js";
import { registerTomb } from "./vfs-registry.js";
import { vfsSeams } from "./vfs-seams.js";
import { HEADER_PATH, tombFileKey } from "./vfs-storage-key.js";

export { HEADER_PATH } from "./vfs-storage-key.js";
export const MIGRATION_MARKER_PATH = "migrated.v1";
export const SEAL_BOUND_MARKER_PATH = "seal-bound.v1";

/** The boot path hydrates public parameters before the first render. */
export function readPlaintextFile(tomb: string, path: string): string | null {
  return vfsSeams.readRaw(tombFileKey(tomb, path));
}

export async function writePlaintextFile(
  tomb: string,
  path: string,
  text: string,
  check?: () => void,
): Promise<void> {
  if (
    path !== HEADER_PATH &&
    path !== MIGRATION_MARKER_PATH &&
    path !== SEAL_BOUND_MARKER_PATH
  )
    throw new VfsError(
      "invalid-path",
      "Only vault headers and migration markers may be written as plaintext.",
    );
  const active = originalVfsCheck(check);
  const key = tombFileKey(tomb, path);
  const guarded =
    check || isIsolatedGuestVaultId(tomb) ? guardedVfsWrite(tomb) : undefined;
  if ((check || isIsolatedGuestVaultId(tomb)) && !guarded)
    throw new VfsError(
      "locked",
      "This storage cannot commit an original-owner write.",
    );
  if (guarded) await guarded(key, text, active);
  else await vfsSeams.writeRaw(key, text);
  active();
  await registerTomb(tomb, active);
  active();
}

export async function deletePlaintextFile(
  tomb: string,
  path: string,
): Promise<void> {
  await vfsSeams.deleteRaw(tombFileKey(tomb, path));
}
