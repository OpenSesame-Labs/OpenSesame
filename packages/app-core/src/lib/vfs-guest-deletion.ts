/** Recover an interrupted protected-guest deletion before accepting another write. */
import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { assertSealed, vaultSealBinding } from "@opensesame/vault-core";
import { originFiles } from "../ports.js";
import { atRestSettled } from "./at-rest/key.js";
import { isIsolatedGuestVaultId } from "./guest-vault-id.js";
import { kvDurability } from "./kv.js";
import { VfsError } from "./vfs-error.js";
import { assertFilePath, parseSealedBlob } from "./vfs-metadata-data.js";
import { INDEX_PATH, reviseIndex } from "./vfs-sealed-index.js";
import { vfsSeams } from "./vfs-seams.js";
import { isTransientGuest } from "./vfs-transient-guest.js";
import { enqueueTombWrite } from "./vfs-write-order.js";

export const GUEST_DELETE_JOURNAL = "guest-delete-journal.v1";
const keyFor = (tomb: string, path: string) => `tomb/${tomb}/${path}`;
const dirty = new Set<string>();
const pending = new Map<string, number>();

export function beginGuestDeletion(tomb: string): () => void {
  pending.set(tomb, (pending.get(tomb) ?? 0) + 1);
  return () => {
    const count = (pending.get(tomb) ?? 1) - 1;
    if (count) pending.set(tomb, count);
    else pending.delete(tomb);
  };
}
export function guestDeletionNeedsAttention(tomb: string): boolean {
  return dirty.has(tomb) || pending.has(tomb);
}

function ports() {
  const { refreshRaw, writeRawGuarded, deleteRawGuarded } = vfsSeams;
  if (!refreshRaw || !writeRawGuarded || !deleteRawGuarded)
    throw new VfsError(
      "locked",
      "This storage cannot safely recover a guest deletion.",
    );
  return { refreshRaw, writeRawGuarded, deleteRawGuarded };
}

function assertPersistentWhenAvailable(): void {
  if (
    originFiles() &&
    atRestSettled()?.durable &&
    kvDurability() !== "persistent"
  )
    throw new VfsError(
      "locked",
      "Guest storage is unavailable. Retry the deletion.",
    );
}

async function idleJournal(key: CryptoKey, tomb: string): Promise<string> {
  const blob = await vfsSeams.seal(
    key,
    { v: 1, idle: true },
    vaultSealBinding(tomb, GUEST_DELETE_JOURNAL),
  );
  assertSealed(blob);
  return JSON.stringify(blob);
}

/** Include a valid journal in the guest's initial, header-last promotion. */
export async function initializeGuestDeletionInTurn(
  tomb: string,
  key: CryptoKey,
  check: () => void,
): Promise<void> {
  if (!isTransientGuest(tomb))
    throw new VfsError("locked", "The guest session has ended.");
  const write = vfsSeams.guestWriteRawGuarded ?? vfsSeams.writeRawGuarded;
  if (!write)
    throw new VfsError("locked", "This storage cannot protect a guest vault.");
  const value = await idleJournal(key, tomb);
  check();
  await write(keyFor(tomb, GUEST_DELETE_JOURNAL), value, check, key);
  check();
}

/** Must run within the per-tomb write turn and the guest's exclusive lease. */
export async function recoverGuestDeletionInTurn(
  tomb: string,
  key: CryptoKey,
  check: () => void,
): Promise<void> {
  if (isTransientGuest(tomb)) return;
  const io = ports();
  const journalKey = keyFor(tomb, GUEST_DELETE_JOURNAL);
  await io.refreshRaw(journalKey, 65536, check);
  check();
  assertPersistentWhenAvailable();
  const raw = vfsSeams.readRaw(journalKey);
  if (raw === null)
    throw new VfsError("corrupt", "The guest deletion journal is missing.");
  const blob = parseSealedBlob(raw, tomb, GUEST_DELETE_JOURNAL);
  const value = await vfsSeams.open<BoundaryValue>(
    key,
    blob,
    vaultSealBinding(tomb, GUEST_DELETE_JOURNAL),
  );
  check();
  if (isJsonObject(value) && value.v === 1 && value.idle === true) {
    dirty.delete(tomb);
    return;
  }
  if (!isJsonObject(value) || value.v !== 1 || !isString(value.path))
    throw new VfsError("corrupt", "The guest deletion could not be recovered.");
  const path = value.path;
  assertFilePath(path);
  if (
    [
      GUEST_DELETE_JOURNAL,
      INDEX_PATH,
      "header",
      "migrated.v1",
      "seal-bound.v1",
    ].includes(path)
  )
    throw new VfsError("corrupt", "The guest deletion could not be recovered.");
  await io.refreshRaw(keyFor(tomb, INDEX_PATH), 8 * 1024 * 1024, check);
  check();
  await io.deleteRawGuarded(keyFor(tomb, path), check);
  check();
  assertPersistentWhenAvailable();
  await reviseIndex(tomb, key, path, false, check, (name, data) =>
    io.writeRawGuarded(name, data, check, key),
  );
  check();
  const idle = await idleJournal(key, tomb);
  check();
  await io.writeRawGuarded(journalKey, idle, check, key);
  check();
  assertPersistentWhenAvailable();
  dirty.delete(tomb);
}

/** Journal first: even a committed deletion interrupted by lock is recoverable. */
export async function deleteGuestFileInTurn(
  tomb: string,
  path: string,
  key: CryptoKey,
  check: () => void,
): Promise<void> {
  const io = ports();
  await recoverGuestDeletionInTurn(tomb, key, check);
  dirty.add(tomb);
  const blob = await vfsSeams.seal(
    key,
    { v: 1, path },
    vaultSealBinding(tomb, GUEST_DELETE_JOURNAL),
  );
  check();
  assertSealed(blob);
  await io.writeRawGuarded(
    keyFor(tomb, GUEST_DELETE_JOURNAL),
    JSON.stringify(blob),
    check,
    key,
  );
  check();
  assertPersistentWhenAvailable();
  await recoverGuestDeletionInTurn(tomb, key, check);
}

/** Drain an outstanding deletion before reading or changing this guest. */
export async function settleGuestDeletionWithKey(
  tomb: string,
  key: CryptoKey,
  requiredKey: () => CryptoKey,
): Promise<void> {
  if (!isIsolatedGuestVaultId(tomb) || !guestDeletionNeedsAttention(tomb))
    return;
  const active = () => {
    if (requiredKey() !== key)
      throw new VfsError("locked", "Original tomb key changed.");
  };
  await enqueueTombWrite(tomb, () =>
    recoverGuestDeletionInTurn(tomb, key, active),
  );
  active();
}

/** Recover a journal while the caller retains the original tomb key. */
export async function recoverGuestDeletionWithKey(
  tomb: string,
  check: () => void,
  requiredKey: () => CryptoKey,
): Promise<void> {
  if (!isIsolatedGuestVaultId(tomb)) return;
  const key = requiredKey();
  const active = () => {
    check();
    if (requiredKey() !== key)
      throw new VfsError("locked", "Original tomb key changed.");
  };
  await enqueueTombWrite(tomb, () =>
    recoverGuestDeletionInTurn(tomb, key, active),
  );
}
