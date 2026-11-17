/** Cross-tab registry admission and recoverable guest reservations. */
import { lockManager } from "../ports.js";
import { kvDurability, kvGet, kvRefresh } from "./kv.js";
import {
  VFS_REGISTRY_LOCK,
  withVfsCrossTabLock,
} from "./vfs-cross-tab-lock.js";
import {
  type TombsRegistry,
  assertTombName,
  parseRegistry,
  parseRegistryForWrite,
} from "./vfs-metadata-data.js";
import { vfsSeams } from "./vfs-seams.js";
import { HEADER_PATH, tombFileKey } from "./vfs-storage-key.js";
import { isTransientGuest } from "./vfs-transient-guest.js";

/** Plaintext top-level registry key — tomb names only, never contents. */
export const TOMBS_REGISTRY_KEY = "tombs.v1";

/* --------------------------------------------------------------- registry */

function readRegistry(): string[] {
  return parseRegistry(vfsSeams.readRaw(TOMBS_REGISTRY_KEY));
}

/** Refresh inside the registry lock so a stale tab cannot erase another vault. */
async function readRegistryForWrite(
  check: () => void = () => {},
): Promise<TombsRegistry> {
  check();
  if (!vfsSeams.refreshRaw && kvDurability() === "persistent")
    throw new Error("The shared vault registry cannot be refreshed safely.");
  await vfsSeams.refreshRaw?.(TOMBS_REGISTRY_KEY, 1024 * 1024, check);
  check();
  if (!lockManager() && kvDurability() === "persistent")
    throw new Error(
      "Shared browser locks are required to change the vault registry safely.",
    );
  return parseRegistryForWrite(vfsSeams.readRaw(TOMBS_REGISTRY_KEY));
}

async function writeRegistry(
  current: TombsRegistry,
  check: () => void = () => {},
  commit: (storageKey: string, value: string) => Promise<void> = (
    storageKey,
    value,
  ) => vfsSeams.writeRaw(storageKey, value),
): Promise<void> {
  check();
  const registry: TombsRegistry = {
    v: 1,
    tombs: [...new Set(current.tombs)].sort(),
  };
  if (
    current.guestReservations &&
    Object.keys(current.guestReservations).length
  )
    registry.guestReservations = current.guestReservations;
  await commit(TOMBS_REGISTRY_KEY, JSON.stringify(registry));
  check();
}

/**
 * Every tomb on this device, by name. Plaintext by design (the `tombs.json`
 * analog — names are not secrets). Sync because the registry hydrates with
 * the rest of the boot keys.
 */
export function listTombs(): string[] {
  return readRegistry();
}

/** Add a tomb to the registry. Idempotent; every tomb write ensures this. */
export async function registerTomb(
  tomb: string,
  check: () => void = () => {},
  commit?: (storageKey: string, value: string) => Promise<void>,
): Promise<void> {
  check();
  assertTombName(tomb);
  if (isTransientGuest(tomb)) return;
  await registerPersistedTomb(tomb, check, commit);
}

/** Reserve a persistent namespace before a transient guest is promoted. */
export async function registerPersistedTomb(
  tomb: string,
  check: () => void = () => {},
  commit?: (storageKey: string, value: string) => Promise<void>,
  requireNew = false,
  reservationProof?: string,
): Promise<void> {
  check();
  assertTombName(tomb);
  await withVfsCrossTabLock(VFS_REGISTRY_LOCK, async () => {
    check();
    const registry = await readRegistryForWrite(check);
    if (registry.tombs.includes(tomb)) {
      if (requireNew) throw new Error("That guest vault already exists.");
      return;
    }
    if (requireNew) await assertNoPhysicalHeader(tomb, check);
    if (registry.tombs.length >= 32)
      throw new Error(
        "This device has too many vaults. Remove one before adding another.",
      );
    await writeRegistry(
      {
        v: 1,
        tombs: [...registry.tombs, tomb],
        guestReservations: reservationProof
          ? { ...registry.guestReservations, [tomb]: reservationProof }
          : registry.guestReservations,
      },
      check,
      commit,
    );
  });
}

/** Prove that an ambiguous reservation belongs to this still-open guest. */
export async function ownsGuestReservation(
  tomb: string,
  proof: string,
): Promise<boolean> {
  return withVfsCrossTabLock(VFS_REGISTRY_LOCK, async () => {
    const registry = await readRegistryForWrite();
    return registry.guestReservations?.[tomb] === proof;
  });
}

export async function clearGuestReservation(
  tomb: string,
  proof: string,
): Promise<void> {
  await withVfsCrossTabLock(VFS_REGISTRY_LOCK, async () => {
    const registry = await readRegistryForWrite();
    if (registry.guestReservations?.[tomb] !== proof) return;
    const reservations = { ...registry.guestReservations };
    delete reservations[tomb];
    await writeRegistry({ ...registry, guestReservations: reservations });
  });
}

/** Reserved guest tombs are not openable until promotion finishes or recovers. */
export async function assertGuestReservationCleared(
  tomb: string,
  check: () => void,
): Promise<void> {
  await withVfsCrossTabLock(VFS_REGISTRY_LOCK, async () => {
    const registry = await readRegistryForWrite(check);
    if (registry.guestReservations?.[tomb])
      throw new Error(
        "This guest vault is still being protected. Try again when it finishes.",
      );
  });
}

/** Recovery holds the exclusive open lease, so the original owner is gone. */
export async function clearRecoveredGuestReservation(
  tomb: string,
): Promise<void> {
  await withVfsCrossTabLock(VFS_REGISTRY_LOCK, async () => {
    const registry = await readRegistryForWrite();
    if (!registry.guestReservations?.[tomb]) return;
    const reservations = { ...registry.guestReservations };
    delete reservations[tomb];
    await writeRegistry({ ...registry, guestReservations: reservations });
  });
}

export function guestReservationPresent(tomb: string): boolean {
  try {
    return Boolean(
      parseRegistryForWrite(vfsSeams.readRaw(TOMBS_REGISTRY_KEY))
        .guestReservations?.[tomb],
    );
  } catch {
    return true;
  }
}

export async function guestReservationExists(tomb: string): Promise<boolean> {
  return withVfsCrossTabLock(VFS_REGISTRY_LOCK, async () =>
    Boolean((await readRegistryForWrite()).guestReservations?.[tomb]),
  );
}

async function assertNoPhysicalHeader(
  tomb: string,
  check: () => void,
): Promise<void> {
  const header = tombFileKey(tomb, HEADER_PATH);
  await kvRefresh(header, 65536, check);
  check();
  if (kvGet(header) !== null)
    throw new Error("This guest vault already exists. Unlock it instead.");
}

/** A resumed temporary guest must never shadow a registered or protected tomb. */
export async function assertUnusedGuestTomb(
  tomb: string,
  check: () => void,
): Promise<void> {
  await withVfsCrossTabLock(VFS_REGISTRY_LOCK, async () => {
    const registry = await readRegistryForWrite(check);
    if (registry.tombs.includes(tomb))
      throw new Error("This guest vault already exists. Unlock it instead.");
    await assertNoPhysicalHeader(tomb, check);
  });
}

export async function unregisterTomb(tomb: string): Promise<void> {
  await withVfsCrossTabLock(VFS_REGISTRY_LOCK, async () => {
    const registry = await readRegistryForWrite();
    if (!registry.tombs.includes(tomb)) return;
    const reservations = { ...registry.guestReservations };
    delete reservations[tomb];
    await writeRegistry({
      ...registry,
      tombs: registry.tombs.filter((name) => name !== tomb),
      guestReservations: reservations,
    });
  });
}
