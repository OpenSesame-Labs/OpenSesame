/**
 * The plaintext tomb registry: tomb names only, never contents (ADR 0063),
 * plus the recoverable reservations of guest vaults being protected.
 */
import { kvGet, kvRefresh } from "./kv.js";
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

function readRegistry(): string[] {
  return parseRegistry(vfsSeams.readRaw(TOMBS_REGISTRY_KEY));
}

/** Under the registry lock: the physical record, so a stale tab erases no vault. */
async function readRegistryForWrite(
  check: () => void = () => {},
): Promise<TombsRegistry> {
  await vfsSeams.refreshRaw?.(TOMBS_REGISTRY_KEY, 1024 * 1024, check);
  check();
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
  const reservations = Object.entries(current.guestReservations ?? {}).filter(
    ([tomb]) => registry.tombs.includes(tomb),
  );
  if (reservations.length)
    registry.guestReservations = Object.fromEntries(reservations);
  await commit(TOMBS_REGISTRY_KEY, JSON.stringify(registry));
  check();
}

/** Drop one reservation, keeping every tomb and every other reservation. */
function withoutReservation(
  registry: TombsRegistry,
  tomb: string,
): TombsRegistry {
  const reservations = { ...registry.guestReservations };
  delete reservations[tomb];
  return { ...registry, guestReservations: reservations };
}

/**
 * Every tomb on this device, by name. Plaintext by design (the `tombs.json`
 * analog — names are not secrets). Sync because the registry hydrates with
 * the rest of the boot keys.
 */
export function listTombs(): string[] {
  return readRegistry();
}

/**
 * Add a tomb to the registry. Idempotent; every tomb write ensures this. A
 * temporary guest lives in this document only and is never registered.
 */
export async function registerTomb(
  tomb: string,
  check: () => void = () => {},
  commit?: (storageKey: string, value: string) => Promise<void>,
): Promise<void> {
  check();
  assertTombName(tomb);
  if (isTransientGuest(tomb)) return;
  await withVfsCrossTabLock(VFS_REGISTRY_LOCK, async () => {
    check();
    if (readRegistry().includes(tomb)) return;
    const registry = await readRegistryForWrite(check);
    if (registry.tombs.includes(tomb)) return;
    await writeRegistry(
      { ...registry, tombs: [...registry.tombs, tomb] },
      check,
      commit,
    );
  });
}

/**
 * Register a guest tomb that is about to be promoted to durable storage. It
 * must be new (no registry entry, no physical header), and it carries the
 * promoting owner's proof until the promotion finishes or is recovered.
 */
export async function registerPersistedTomb(
  tomb: string,
  check: () => void,
  reservationProof: string,
): Promise<void> {
  check();
  assertTombName(tomb);
  if (!/^[0-9a-f-]{36}$/u.test(reservationProof))
    throw new Error("Invalid guest reservation.");
  await withVfsCrossTabLock(VFS_REGISTRY_LOCK, async () => {
    check();
    const registry = await readRegistryForWrite(check);
    if (registry.tombs.includes(tomb))
      throw new Error("That guest vault already exists.");
    await assertNoPhysicalHeader(tomb, check);
    await writeRegistry(
      {
        v: 1,
        tombs: [...registry.tombs, tomb],
        guestReservations: {
          ...registry.guestReservations,
          [tomb]: reservationProof,
        },
      },
      check,
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

/** Clear a reservation; with a proof, only the owner's own. */
export async function clearGuestReservation(
  tomb: string,
  proof?: string,
): Promise<void> {
  await withVfsCrossTabLock(VFS_REGISTRY_LOCK, async () => {
    const registry = await readRegistryForWrite();
    const held = registry.guestReservations?.[tomb];
    if (!held || (proof !== undefined && held !== proof)) return;
    await writeRegistry(withoutReservation(registry, tomb));
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

/** From this tab's copy; an unreadable registry counts as reserved. */
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

/** The device's durable header, never a live guest's in-document copy. */
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
    if (!readRegistry().includes(tomb)) return;
    const registry = await readRegistryForWrite();
    if (!registry.tombs.includes(tomb)) return;
    await writeRegistry({
      ...withoutReservation(registry, tomb),
      tombs: registry.tombs.filter((name) => name !== tomb),
    });
  });
}
