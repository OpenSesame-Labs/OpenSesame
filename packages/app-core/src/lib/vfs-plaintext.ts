/** Plaintext VFS metadata: public header parameters and migration markers. */
import { isIsolatedGuestVaultId } from "./guest-vault-id.js";
import { VfsError } from "./vfs-error.js";
import { guardedVfsWrite, originalVfsCheck } from "./vfs-operation-check.js";
import { registerTomb } from "./vfs-registry.js";
import { vfsSeams } from "./vfs-seams.js";
import { tombFileKey } from "./vfs-storage-key.js";

export { HEADER_PATH } from "./vfs-storage-key.js";
/** Idempotent legacy-migration marker (plaintext; names, not contents). */
export const MIGRATION_MARKER_PATH = "migrated.v1";
/** Written after unlock rewrites every seal with a path binding. */
export const SEAL_BOUND_MARKER_PATH = "seal-bound.v1";

/**
 * Read a plaintext tomb file (header params, migration marker). Sync: the
 * boot path hydrates these keys before first paint, exactly like the legacy
 * header key. Plaintext here is the documented ADR 0063 boundary — public
 * parameters, never vault content.
 */
export function readPlaintextFile(tomb: string, path: string): string | null {
  return vfsSeams.readRaw(tombFileKey(tomb, path));
}

export async function writePlaintextFile(
  tomb: string,
  path: string,
  text: string,
  check?: () => void,
): Promise<void> {
  const active = originalVfsCheck(check);
  const key = tombFileKey(tomb, path);
  // An isolated guest's plaintext always goes through the guarded transport,
  // so an in-memory guest never leaks a header to durable storage.
  if (isIsolatedGuestVaultId(tomb)) {
    const guarded = guardedVfsWrite(tomb);
    if (!guarded)
      throw new VfsError(
        "locked",
        "This storage cannot commit an original-owner write.",
      );
    await guarded(key, text, active);
  } else await vfsSeams.writeRaw(key, text);
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
