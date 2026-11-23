/** The plaintext tomb registry: tomb names only, never contents (ADR 0063). */
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

/** Plaintext top-level registry key — tomb names only, never contents. */
export const TOMBS_REGISTRY_KEY = "tombs.v1";

function readRegistry(): string[] {
  return parseRegistry(vfsSeams.readRaw(TOMBS_REGISTRY_KEY));
}

/** Under the registry lock: the physical record, so a stale tab erases no vault. */
async function readRegistryForWrite(check: () => void): Promise<string[]> {
  await vfsSeams.refreshRaw?.(TOMBS_REGISTRY_KEY, 1024 * 1024, check);
  check();
  return parseRegistryForWrite(vfsSeams.readRaw(TOMBS_REGISTRY_KEY));
}

async function writeRegistry(
  names: string[],
  check: () => void = () => {},
  commit: (storageKey: string, value: string) => Promise<void> = (
    storageKey,
    value,
  ) => vfsSeams.writeRaw(storageKey, value),
): Promise<void> {
  check();
  const registry: TombsRegistry = {
    v: 1,
    tombs: [...new Set(names)].sort(),
  };
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
  await withVfsCrossTabLock(VFS_REGISTRY_LOCK, async () => {
    check();
    if (readRegistry().includes(tomb)) return;
    const names = await readRegistryForWrite(check);
    if (names.includes(tomb)) return;
    await writeRegistry([...names, tomb], check, commit);
  });
}

export async function unregisterTomb(tomb: string): Promise<void> {
  await withVfsCrossTabLock(VFS_REGISTRY_LOCK, async () => {
    if (!readRegistry().includes(tomb)) return;
    const names = await readRegistryForWrite(() => {});
    if (!names.includes(tomb)) return;
    await writeRegistry(names.filter((name) => name !== tomb));
  });
}
