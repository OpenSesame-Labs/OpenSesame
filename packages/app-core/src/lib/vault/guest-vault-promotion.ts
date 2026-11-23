/** Promote one in-memory guest without moving its encrypted tomb. */
import { type BoundaryValue, isString } from "@opensesame/os-domain";
import { lockManager, originFiles } from "../../ports.js";
import { isIsolatedGuestVaultId } from "../guest-vault-id.js";
import {
  kvDeleteDurable,
  kvDurability,
  kvGet,
  kvRefresh,
  kvSetDurable,
} from "../kv.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  tombFileKey,
  unregisterTomb,
  vfsSeams,
} from "../vfs.js";
import { withVfsCrossTabLock } from "../vfs-cross-tab-lock.js";
import {
  clearGuestReservation,
  guestReservationExists,
  ownsGuestReservation,
  registerPersistedTomb,
} from "../vfs-registry.js";
import {
  freezeTransientGuest,
  releaseRetiredTransientGuest,
  releaseTransientGuest,
  setTransientGuestBlocked,
  thawTransientGuest,
  transientGuestBlocked,
} from "../vfs-transient-guest.js";
import { vfsFlush } from "../vfs-write-order.js";
import { headerCarriesGate } from "./header-gate.js";
import { withExclusiveOpenLease } from "./vault-shared-locks.js";

const HEADER_LIMIT = 65536;
const LIFETIME_PREFIX = "opensesame:guest-vault-lifetime:";
const PROMOTION_PATH = "promotion.v1";
const PROMOTION_LIMIT = 1024 * 1024;
const reservationProofs = new Map<symbol, string>();
const attemptedFiles = new Map<symbol, ReadonlyMap<string, string>>();

/** A persistent guest cannot be promoted without cross-tab serialization. */
function requireLifetimeLock(): void {
  if (!lockManager() && originFiles() && kvDurability() !== "memory")
    throw new Error(
      "This browser cannot safely protect a guest vault without shared locks.",
    );
}

async function deleteAndVerify(key: string): Promise<void> {
  await kvDeleteDurable(key);
  await kvRefresh(key, PROMOTION_LIMIT);
  if (kvGet(key) !== null) throw new Error("Guest cleanup did not finish.");
}

async function verifyFiles(
  files: ReadonlyMap<string, string>,
  check: () => void,
): Promise<void> {
  for (const [key, value] of files) {
    await kvRefresh(key, 256 * 1024 * 1024, check);
    check();
    if (kvGet(key) !== value)
      throw new Error(
        "The protected guest vault could not be verified. Keep this tab open and try again.",
      );
  }
}

async function discardIncomplete(
  tomb: string,
): Promise<"protected" | "discarded" | "unknown"> {
  const header = tombFileKey(tomb, HEADER_PATH);
  const marker = tombFileKey(tomb, PROMOTION_PATH);
  try {
    // Uncertainty keeps all data and its registry entry; it never means absent.
    await kvRefresh(header, HEADER_LIMIT);
    if (kvGet(header) !== null) {
      const body = tombFileKey(tomb, BODY_PATH);
      const index = tombFileKey(tomb, INDEX_PATH);
      await kvRefresh(body, 256 * 1024 * 1024);
      await kvRefresh(index, PROMOTION_LIMIT);
      if (kvGet(body) === null || kvGet(index) === null) return "unknown";
      return "protected";
    }
    await kvRefresh(marker, PROMOTION_LIMIT);
    const raw = kvGet(marker);
    if (raw !== null) {
      const parsed: BoundaryValue = JSON.parse(raw);
      const prefix = `tomb/${tomb}/`;
      const keys: string[] = [];
      for (const entry of Array.isArray(parsed) ? parsed : [null]) {
        if (!isString(entry)) throw new Error("Invalid guest recovery record.");
        keys.push(entry);
      }
      if (
        keys.some(
          (key) => !key.startsWith(prefix) || key === header || key === marker,
        )
      )
        throw new Error("Invalid guest recovery record.");
      for (const key of keys) {
        if (tombFileKey(tomb, key.slice(prefix.length)) !== key)
          throw new Error("Invalid guest recovery path.");
      }
      for (const key of keys) await deleteAndVerify(key);
      await deleteAndVerify(marker);
    }
    await unregisterTomb(tomb);
    return "discarded";
  } catch {
    // A later recovery may retry after storage becomes available.
    return "unknown";
  }
}

async function recoverFailedPromotion(
  tomb: string,
  owner: symbol,
  proof: string,
  files: ReadonlyMap<string, string>,
  headerKey: string,
  header: string | undefined,
  check: () => void,
): Promise<boolean> {
  const recovery = await discardIncomplete(tomb);
  if (recovery === "protected" && kvGet(headerKey) === header) {
    try {
      check();
      await verifyFiles(files, check);
      check();
      releaseTransientGuest(tomb, owner);
      reservationProofs.delete(owner);
      attemptedFiles.delete(owner);
      await clearGuestReservation(tomb, proof).catch(() => undefined);
      return true;
    } catch {
      // Leave the reservation and memory fenced until recovery can verify it.
    }
  }
  if (recovery === "discarded") {
    reservationProofs.delete(owner);
    attemptedFiles.delete(owner);
  } else setTransientGuestBlocked(tomb, owner, true);
  return false;
}

export async function promoteGuestVault(
  tomb: string,
  owner: symbol,
  check: () => void,
): Promise<void> {
  if (vfsSeams.authenticationStorage === "file-backed")
    throw new Error(
      "This storage cannot protect a temporary guest vault. Use a local browser vault to keep these items.",
    );
  requireLifetimeLock();
  let proof = reservationProofs.get(owner);
  if (!proof) {
    proof = crypto.randomUUID();
    reservationProofs.set(owner, proof);
  }
  await withVfsCrossTabLock(`${LIFETIME_PREFIX}${tomb}`, async () => {
    check();
    if (await ownsGuestReservation(tomb, proof)) {
      const recovery = await discardIncomplete(tomb);
      if (recovery === "unknown")
        throw new Error(
          "Storage is unavailable. Try protecting this guest vault again.",
        );
      if (recovery === "protected")
        throw new Error(
          "The previous protection attempt must be recovered before trying again.",
        );
    }
    const files = freezeTransientGuest(tomb, owner);
    const headerKey = tombFileKey(tomb, HEADER_PATH);
    const header = files.get(headerKey);
    let registered = false;
    try {
      if (
        !header ||
        !headerCarriesGate(JSON.parse(header)) ||
        !files.has(tombFileKey(tomb, BODY_PATH)) ||
        !files.has(tombFileKey(tomb, INDEX_PATH))
      )
        throw new Error("The guest vault is not ready to protect.");
      // The registry must name the tomb before any physical vault files exist.
      attemptedFiles.set(owner, files);
      await registerPersistedTomb(tomb, check, proof);
      registered = true;
      // Recovery needs the complete list before any encrypted files are copied.
      const marker = tombFileKey(tomb, PROMOTION_PATH);
      const keys = [...files.keys()].filter((key) => key !== headerKey);
      const manifest = JSON.stringify(keys);
      if (new TextEncoder().encode(manifest).length > PROMOTION_LIMIT)
        throw new Error("This guest vault has too many files to protect.");
      await kvSetDurable(marker, manifest, check);
      for (const [key, value] of files) {
        if (key !== headerKey) await kvSetDurable(key, value, check);
      }
      // A discoverable key header is the last durable write.
      await kvSetDurable(headerKey, header, check);
      releaseTransientGuest(tomb, owner);
      reservationProofs.delete(owner);
      attemptedFiles.delete(owner);
      await clearGuestReservation(tomb, proof).catch(() => undefined);
      // A leftover marker beside a protected header is harmless and recoverable.
      await kvDeleteDurable(marker).catch(() => undefined);
    } catch (error) {
      if (
        registered &&
        (await recoverFailedPromotion(
          tomb,
          owner,
          proof,
          files,
          headerKey,
          header,
          check,
        ))
      )
        return;
      throw error;
    } finally {
      thawTransientGuest(tomb, owner);
    }
  });
}

/** Resolve an uncertain commit before any new header or vault edit is admitted. */
export async function recoverLiveGuestPromotion(
  tomb: string,
  owner: symbol,
  check: () => void,
): Promise<boolean> {
  if (!transientGuestBlocked(tomb, owner)) return false;
  const proof = reservationProofs.get(owner);
  const files = attemptedFiles.get(owner);
  if (!proof || !files)
    throw new Error(
      "Guest protection is still being verified. Try again when storage is available.",
    );
  return withVfsCrossTabLock(`${LIFETIME_PREFIX}${tomb}`, async () => {
    check();
    if (!(await ownsGuestReservation(tomb, proof)))
      throw new Error("The guest vault reservation could not be verified.");
    const result = await discardIncomplete(tomb);
    if (result === "unknown")
      throw new Error(
        "Guest protection is still being verified. Try again when storage is available.",
      );
    if (result === "discarded") {
      setTransientGuestBlocked(tomb, owner, false);
      reservationProofs.delete(owner);
      attemptedFiles.delete(owner);
      return false;
    }
    await verifyFiles(files, check);
    check();
    releaseTransientGuest(tomb, owner);
    reservationProofs.delete(owner);
    attemptedFiles.delete(owner);
    await clearGuestReservation(tomb, proof).catch(() => undefined);
    return true;
  });
}

/** Reclaim an interrupted promotion only after proving no protected vault exists. */
export async function recoverIncompleteGuestVaults(
  tombs: readonly string[],
): Promise<void> {
  if (!lockManager() && originFiles() && kvDurability() !== "memory") return;
  for (const tomb of tombs.filter(isIsolatedGuestVaultId)) {
    try {
      if (!(await guestReservationExists(tomb))) continue;
      await withVfsCrossTabLock(`${LIFETIME_PREFIX}${tomb}`, () =>
        withExclusiveOpenLease(tomb, async () => {
          const result = await discardIncomplete(tomb);
          if (result === "protected") await clearGuestReservation(tomb);
          if (result !== "unknown") {
            await vfsFlush();
            releaseRetiredTransientGuest(tomb);
          }
        }),
      );
    } catch {
      // An open vault or inaccessible storage is left untouched for a later boot.
    }
  }
}
