import type { BoundaryValue } from "@opensesame/os-domain";
import {
  type SealedBlob,
  assertSealed,
  bytesToB64,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { isIsolatedGuestVaultId } from "./guest-vault-id.js";
import { deleteSealedFile } from "./vfs-delete.js";
import {
  GUEST_DELETE_JOURNAL,
  guestDeletionNeedsAttention,
  recoverGuestDeletionInTurn,
  recoverGuestDeletionWithKey,
  settleGuestDeletionWithKey,
} from "./vfs-guest-deletion.js";
import { tombFileKey } from "./vfs-storage-key.js";

export { tombFileKey } from "./vfs-storage-key.js";

import {
  type SealedFileEnvelope,
  assertFilePath,
  assertTombName,
  parseEnvelope,
  parseSealedBlob,
} from "./vfs-metadata-data.js";
import { guardedVfsWrite, originalVfsCheck } from "./vfs-operation-check.js";
import {
  HEADER_PATH,
  MIGRATION_MARKER_PATH,
  SEAL_BOUND_MARKER_PATH,
} from "./vfs-plaintext.js";
import { INDEX_PATH, readIndex, reviseIndex } from "./vfs-sealed-index.js";
import { vfsSeams } from "./vfs-seams.js";
import {
  createTombLifetime,
  createUnlockEpochTracker,
} from "./vfs-tomb-keys.js";
import { isTransientGuest } from "./vfs-transient-guest.js";
import { type TombWriteTurn, enqueueTombWrite } from "./vfs-write-order.js";

export { vfsFlush } from "./vfs-write-order.js";

/**
 * Encrypted VFS (ADR 0063). AES-GCM seals bind tomb and path as additional
 * data. Plaintext is tomb names, headers and migration markers. Storage is OPFS.
 */

import { VfsError } from "./vfs-error.js";

export { VfsError, type VfsErrorCode } from "./vfs-error.js";

export const PERSONAL_TOMB = "personal"; // same as the personal project id
/** Isolated guest session tomb — never a project in the vault list. */
export const GUEST_TOMB = "guest";

import { registerTomb } from "./vfs-registry.js";

export {
  TOMBS_REGISTRY_KEY,
  assertGuestReservationCleared,
  assertUnusedGuestTomb,
  clearGuestReservation,
  clearRecoveredGuestReservation,
  guestReservationExists,
  guestReservationPresent,
  listTombs,
  ownsGuestReservation,
  registerPersistedTomb,
  registerTomb,
  unregisterTomb,
} from "./vfs-registry.js";

export const BODY_PATH = "body";
export {
  HEADER_PATH,
  MIGRATION_MARKER_PATH,
  SEAL_BOUND_MARKER_PATH,
  deletePlaintextFile,
  readPlaintextFile,
  writePlaintextFile,
} from "./vfs-plaintext.js";
export { INDEX_PATH } from "./vfs-sealed-index.js";

export { type VfsSeams, vfsSeams } from "./vfs-seams.js";

function assertSealedPath(path: string): void {
  if (path === INDEX_PATH || path === GUEST_DELETE_JOURNAL) {
    throw new VfsError(
      "invalid-path",
      "The tomb index is maintained by the VFS itself.",
    );
  }
  if (
    path === HEADER_PATH ||
    path === MIGRATION_MARKER_PATH ||
    path === SEAL_BOUND_MARKER_PATH
  ) {
    throw new VfsError(
      "invalid-path",
      `"${path}" is a plaintext file — use the plaintext helpers.`,
    );
  }
}

// The key registry remains private. Callers can capture only check functions.
type TombOwner = Readonly<{ key: CryptoKey; token: symbol; check: () => void }>;
const owners = new Map<string, TombOwner>();
const unlockEpoch = createUnlockEpochTracker();
// A held check closes over this token only, never the key-owning record.
const tombLifetime = (tomb: string, token: symbol): (() => void) =>
  createTombLifetime(() => owners.get(tomb)?.token === token);

export function unlockTomb(tomb: string, key: CryptoKey): void {
  assertTombName(tomb);
  const token = Symbol("vfs-owner");
  owners.set(tomb, { key, token, check: tombLifetime(tomb, token) });
  unlockEpoch.changed(tomb);
}
export function lockTomb(tomb: string): void {
  owners.delete(tomb);
  unlockEpoch.changed(tomb);
}
export function lockAllTombs(): void {
  owners.clear();
  unlockEpoch.reset();
}
export function tombUnlocked(tomb: string): boolean {
  return owners.has(tomb);
}
const currentTombOwner = (tomb: string): TombOwner | undefined =>
  owners.get(tomb);
function requireTombOwner(tomb: string): TombOwner {
  const owner = currentTombOwner(tomb);
  if (!owner)
    throw new VfsError(
      "locked",
      `Tomb "${tomb}" is locked — unlock its vault before reading or writing sealed files.`,
    );
  return owner;
}
/** Capture an unlocked lifetime without granting access to its vault key. */
export function requireTombCheck(tomb: string): () => void {
  return requireTombOwner(tomb).check;
}
/** Also fence pre-unlock work against any intervening unlock lifetime. */
export function captureTombEpoch(tomb: string): () => void {
  const owner = currentTombOwner(tomb);
  if (owner) return owner.check;
  return unlockEpoch.capture(tomb);
}

/**
 * Seal `bytes` under the tomb's vault key and store them, then bump the
 * file's revision in the sealed index. Requires an unlocked tomb.
 */
export async function writeFile(
  tomb: string,
  path: string,
  bytes: Uint8Array,
  check?: () => void,
  turn?: TombWriteTurn,
): Promise<void> {
  assertSealedPath(path);
  const operation = originalVfsCheck(check);
  const owner = requireTombOwner(tomb);
  const originalKey = owner.key;
  const guarded = guardedVfsWrite(tomb);
  if (!guarded)
    throw new VfsError(
      "locked",
      "This storage cannot commit an original-owner write.",
    );
  const active = () => {
    operation();
    owner.check();
  };
  await enqueueTombWrite(
    tomb,
    async () => {
      active();
      if (isIsolatedGuestVaultId(tomb) && guestDeletionNeedsAttention(tomb))
        await recoverGuestDeletionInTurn(tomb, originalKey, active);
      const key = owner.key;
      const commit = (storageKey: string, value: string) =>
        guarded(storageKey, value, active, key);
      const envelope: SealedFileEnvelope = { v: 1, dataB64: bytesToB64(bytes) };
      const blob = await vfsSeams.seal(
        key,
        envelope,
        vaultSealBinding(tomb, path),
      );
      active();
      assertSealed(blob);
      await commit(tombFileKey(tomb, path), JSON.stringify(blob));
      active();
      await reviseIndex(tomb, key, path, true, active, commit);
      active();
      await registerTomb(tomb, active, commit);
      active();
    },
    turn,
  );
}

/**
 * Unseal a file. Throws `VfsError("not-found")` when the path has no file,
 * `VfsError("locked")` before the tomb is unlocked.
 */
export async function readFile(
  tomb: string,
  path: string,
): Promise<Uint8Array> {
  assertSealedPath(path);
  const owner = requireTombOwner(tomb);
  const key = owner.key;
  const operation = originalVfsCheck();
  await settleGuestDeletion(tomb, key);
  const active = () => {
    operation();
    owner.check();
  };
  if (!isTransientGuest(tomb))
    await vfsSeams.refreshRaw?.(
      tombFileKey(tomb, path),
      256 * 1024 * 1024,
      active,
    );
  active();
  const raw = vfsSeams.readRaw(tombFileKey(tomb, path));
  if (raw === null) {
    throw new VfsError("not-found", `tomb "${tomb}" has no file at "${path}".`);
  }
  const blob = parseSealedBlob(raw, tomb, path);
  const opened = await vfsSeams.open<BoundaryValue>(
    key,
    blob,
    vaultSealBinding(tomb, path),
  );
  active();
  return parseEnvelope(opened, tomb, path);
}

/**
 * List file paths under `prefix` ("" for everything) from the sealed index.
 * Names never leave the tomb unencrypted — listing needs the key.
 */
export async function listDir(tomb: string, prefix: string): Promise<string[]> {
  assertTombName(tomb);
  const trimmed = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  if (trimmed) assertFilePath(trimmed);
  const owner = requireTombOwner(tomb);
  const key = owner.key;
  const operation = originalVfsCheck();
  const active = () => {
    operation();
    owner.check();
  };
  await settleGuestDeletion(tomb, key);
  const index = await readIndex(tomb, key, active);
  active();
  return Object.keys(index.files)
    .filter(
      (path) =>
        trimmed === "" || path === trimmed || path.startsWith(`${trimmed}/`),
    )
    .sort();
}

/** Remove a sealed file and its index entry. Locked ciphertext stays. */
export async function deleteFile(tomb: string, path: string): Promise<void> {
  assertSealedPath(path);
  return deleteSealedFile(tomb, path, {
    current: () => currentTombOwner(tomb),
    required: () => requireTombOwner(tomb),
  });
}

function settleGuestDeletion(tomb: string, key: CryptoKey): Promise<void> {
  const owner = requireTombOwner(tomb);
  return settleGuestDeletionWithKey(tomb, key, () => {
    owner.check();
    return owner.key;
  });
}

/** Recover durable deletion state while the unlock still owns its guest lease. */
export function recoverGuestDeletion(
  tomb: string,
  check: () => void,
): Promise<void> {
  const owner = requireTombOwner(tomb);
  return recoverGuestDeletionWithKey(
    tomb,
    () => {
      check();
      owner.check();
    },
    () => owner.key,
  );
}

/* ------------------------------------------------- verbatim sealed (body) */

/** Read a caller-sealed blob verbatim. The store seals the body; opening it still takes the vault key. */
export function readSealedFile(tomb: string, path: string): SealedBlob | null {
  assertSealedPath(path);
  if (isIsolatedGuestVaultId(tomb) && guestDeletionNeedsAttention(tomb))
    throw new VfsError("locked", "A guest deletion is still being recovered.");
  const raw = vfsSeams.readRaw(tombFileKey(tomb, path));
  if (raw === null) return null;
  return parseSealedBlob(raw, tomb, path);
}

/**
 * Store a caller-sealed blob verbatim and record it in the index. The key is
 * required for the index update, not for the content.
 */
export async function writeSealedFile(
  tomb: string,
  path: string,
  blob: SealedBlob,
  check?: () => void,
  turn?: TombWriteTurn,
): Promise<void> {
  const operation = originalVfsCheck(check);
  assertSealedPath(path);
  const owner = requireTombOwner(tomb);
  const key = owner.key;
  const fileBackedBody =
    vfsSeams.authenticationStorage === "file-backed" &&
    path === BODY_PATH &&
    !isIsolatedGuestVaultId(tomb);
  const guarded = guardedVfsWrite(tomb);
  const ownedBody = fileBackedBody ? vfsSeams.writeOwnedBody : undefined;
  if (!guarded || (fileBackedBody && !ownedBody))
    throw new VfsError(
      "locked",
      "This storage cannot commit an original-owner write.",
    );
  const active = () => {
    operation();
    owner.check();
  };
  await enqueueTombWrite(
    tomb,
    async () => {
      active();
      if (isIsolatedGuestVaultId(tomb) && guestDeletionNeedsAttention(tomb))
        await recoverGuestDeletionInTurn(tomb, key, active);
      assertSealed(blob);
      const commit = (storageKey: string, value: string) =>
        guarded(storageKey, value, active, key);
      const storageKey = tombFileKey(tomb, path);
      if (ownedBody)
        await ownedBody(storageKey, JSON.stringify(blob), active, key);
      else await commit(storageKey, JSON.stringify(blob));
      active();
      await reviseIndex(tomb, key, path, true, active, commit);
      active();
      await registerTomb(tomb, active, commit);
      active();
    },
    turn,
  );
}

/**
 * Record an existing sealed file in the index without rewriting its content
 * (a body moved pre-unlock never got an index entry — phase B had no key).
 */
export async function ensureIndexed(tomb: string, path: string): Promise<void> {
  assertSealedPath(path);
  const owner = requireTombOwner(tomb);
  const operation = originalVfsCheck();
  const active = () => {
    operation();
    owner.check();
  };
  const key = owner.key;
  const guarded = guardedVfsWrite(tomb);
  if (!guarded)
    throw new VfsError(
      "locked",
      "This storage cannot commit an original-owner write.",
    );
  await enqueueTombWrite(tomb, async () => {
    active();
    if (isIsolatedGuestVaultId(tomb) && guestDeletionNeedsAttention(tomb))
      await recoverGuestDeletionInTurn(tomb, key, active);
    if (vfsSeams.readRaw(tombFileKey(tomb, path)) === null) return;
    const index = await readIndex(tomb, key, active);
    if (index.files[path] !== undefined) return;
    await reviseIndex(tomb, key, path, true, active, (name, value) =>
      guarded(name, value, active, key),
    );
  });
}
