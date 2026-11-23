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
import { registerTomb } from "./vfs-registry.js";
import { INDEX_PATH, readIndex, reviseIndex } from "./vfs-sealed-index.js";
import { vfsSeams } from "./vfs-seams.js";
import { tombFileKey } from "./vfs-storage-key.js";
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

// Guest reservations are imported from ./vfs-registry.js directly.
export {
  TOMBS_REGISTRY_KEY,
  listTombs,
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
export { tombFileKey } from "./vfs-storage-key.js";

/* ------------------------------------------------------------- tomb keys */

/** Session vault key for one tomb. Dropped on lock; sealed I/O then fails locked. */
const tombKeys = new Map<string, CryptoKey>();
/** One token per unlock lifetime: a lock, or a different key, starts a new one. */
const tombLifetimes = new Map<string, object>();
/** One token per locked-to-unlocked transition; a key rotation keeps it. */
const tombSessions = new Map<string, object>();

export function unlockTomb(tomb: string, key: CryptoKey): void {
  assertTombName(tomb);
  if (!tombKeys.has(tomb)) tombSessions.set(tomb, {});
  if (tombKeys.get(tomb) !== key) tombLifetimes.set(tomb, {});
  tombKeys.set(tomb, key);
}

export function lockTomb(tomb: string): void {
  tombKeys.delete(tomb);
}

export function lockAllTombs(): void {
  tombKeys.clear();
}

export function tombUnlocked(tomb: string): boolean {
  return tombKeys.has(tomb);
}

/**
 * Capture the tomb's current unlock lifetime without its key. The check fails
 * once that lifetime ends, even when a later unlock uses the same key.
 */
export function requireTombCheck(tomb: string): () => void {
  requireTombKey(tomb);
  const lifetime = tombLifetimes.get(tomb);
  return () => {
    if (!tombKeys.has(tomb) || tombLifetimes.get(tomb) !== lifetime)
      throw new VfsError("locked", "The vault was locked in the meantime.");
  };
}

/** Like requireTombCheck, but a key rotation within the same unlock keeps it. */
function requireTombSession(tomb: string): () => void {
  requireTombKey(tomb);
  const session = tombSessions.get(tomb);
  return () => {
    if (!tombKeys.has(tomb) || tombSessions.get(tomb) !== session)
      throw new VfsError("locked", "The vault was locked in the meantime.");
  };
}

/**
 * Fence work that may start while the tomb is locked: the check fails once any
 * unlock lifetime begins or ends after capture. It never holds the key.
 */
export function captureTombEpoch(tomb: string): () => void {
  if (tombKeys.has(tomb)) return requireTombCheck(tomb);
  const lifetime = tombLifetimes.get(tomb);
  return () => {
    if (tombKeys.has(tomb) || tombLifetimes.get(tomb) !== lifetime)
      throw new VfsError("locked", "The vault was unlocked in the meantime.");
  };
}

function requireTombKey(tomb: string): CryptoKey {
  const key = tombKeys.get(tomb);
  if (!key) {
    throw new VfsError(
      "locked",
      `Tomb "${tomb}" is locked — unlock its vault before reading or writing sealed files.`,
    );
  }
  return key;
}

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

/* ------------------------------------------------------------ sealed files */

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
  // A checked write keeps its key and lifetime; an unchecked one survives a key
  // rotation within the same unlock, never a lock (even one reusing the key).
  const originalKey = check ? requireTombKey(tomb) : null;
  const owner = check ? requireTombCheck(tomb) : requireTombSession(tomb);
  // A guest's writes always go through the guarded transport, so an
  // in-memory guest never reaches durable storage by an unguarded path.
  const guest = isIsolatedGuestVaultId(tomb);
  const guarded = guardedVfsWrite(tomb);
  if ((check || guest) && !guarded)
    throw new VfsError(
      "locked",
      "This storage cannot commit an original-owner write.",
    );
  const active = () => {
    operation();
    owner();
  };
  await enqueueTombWrite(
    tomb,
    async () => {
      active();
      const key = originalKey ?? requireTombKey(tomb);
      if (guest && guestDeletionNeedsAttention(tomb))
        await recoverGuestDeletionInTurn(tomb, key, active);
      const commit = (storageKey: string, value: string) =>
        (check || guest) && guarded
          ? guarded(storageKey, value, active, key)
          : vfsSeams.writeRaw(storageKey, value, key);
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
  const key = requireTombKey(tomb);
  await settleGuestDeletion(tomb, key);
  const raw = vfsSeams.readRaw(tombFileKey(tomb, path));
  if (raw === null) {
    throw new VfsError("not-found", `tomb "${tomb}" has no file at "${path}".`);
  }
  const blob = parseSealedBlob(raw, tomb, path);
  return parseEnvelope(
    await vfsSeams.open(key, blob, vaultSealBinding(tomb, path)),
    tomb,
    path,
  );
}

/**
 * List file paths under `prefix` ("" for everything) from the sealed index.
 * Names never leave the tomb unencrypted — listing needs the key.
 */
export async function listDir(tomb: string, prefix: string): Promise<string[]> {
  assertTombName(tomb);
  const trimmed = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  if (trimmed) assertFilePath(trimmed);
  const key = requireTombKey(tomb);
  await settleGuestDeletion(tomb, key);
  const index = await readIndex(tomb, key);
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
  const key = tombKeys.get(tomb);
  if (!key) {
    if (vfsSeams.readRaw(tombFileKey(tomb, path)) !== null)
      requireTombKey(tomb);
    return;
  }
  return deleteSealedFile(
    tomb,
    path,
    tombFileKey(tomb, path),
    () => requireTombKey(tomb),
    requireTombSession(tomb),
  );
}

/** Drain an interrupted guest deletion before reading this guest's files. */
function settleGuestDeletion(tomb: string, key: CryptoKey): Promise<void> {
  const session = requireTombSession(tomb);
  return settleGuestDeletionWithKey(tomb, key, () => {
    session();
    return requireTombKey(tomb);
  });
}

/** Recover durable deletion state while the unlock still owns its guest lease. */
export function recoverGuestDeletion(
  tomb: string,
  check: () => void,
): Promise<void> {
  const owner = requireTombCheck(tomb);
  return recoverGuestDeletionWithKey(
    tomb,
    () => {
      check();
      owner();
    },
    () => requireTombKey(tomb),
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
  const key = requireTombKey(tomb);
  const owner = requireTombCheck(tomb);
  // A file-backed body is many files; only its owned projection may write it.
  // A guest's body is one guarded blob, in this document until promotion.
  const guest = isIsolatedGuestVaultId(tomb);
  const fileBackedBody =
    vfsSeams.authenticationStorage === "file-backed" &&
    path === BODY_PATH &&
    !guest;
  const ownedBody = fileBackedBody ? vfsSeams.writeOwnedBody : undefined;
  const guarded = guest ? guardedVfsWrite(tomb) : undefined;
  if ((fileBackedBody && !ownedBody) || (guest && !guarded))
    throw new VfsError(
      "locked",
      "This storage cannot commit an original-owner write.",
    );
  const active = () => {
    operation();
    owner();
  };
  await enqueueTombWrite(
    tomb,
    async () => {
      active();
      if (guest && guestDeletionNeedsAttention(tomb))
        await recoverGuestDeletionInTurn(tomb, key, active);
      assertSealed(blob);
      const storageKey = tombFileKey(tomb, path);
      const commit = guarded
        ? (name: string, value: string) => guarded(name, value, active, key)
        : undefined;
      if (ownedBody)
        await ownedBody(storageKey, JSON.stringify(blob), active, key);
      else if (commit) await commit(storageKey, JSON.stringify(blob));
      else await vfsSeams.writeRaw(storageKey, JSON.stringify(blob), key);
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
  await enqueueTombWrite(tomb, async () => {
    const key = requireTombKey(tomb);
    if (isIsolatedGuestVaultId(tomb) && guestDeletionNeedsAttention(tomb))
      await recoverGuestDeletionInTurn(tomb, key, () => requireTombKey(tomb));
    if (vfsSeams.readRaw(tombFileKey(tomb, path)) === null) return;
    const index = await readIndex(tomb, key);
    if (index.files[path] !== undefined) return;
    await reviseIndex(tomb, key, path, true);
  });
}
