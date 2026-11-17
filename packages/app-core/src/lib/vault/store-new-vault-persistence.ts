import type { VaultHeader } from "@opensesame/vault-core";
import { HEADER_PATH, writePlaintextFile } from "../vfs.js";
import { hydrateAndMigrateTombOnUnlock } from "./tomb-migration.js";

/** Finish the new vault's files and legacy configuration before publishing it. */
export async function initializeNewVaultFiles(
  tomb: string,
  header: VaultHeader,
  check: () => void,
  persist: () => Promise<void>,
  loadPreferences: () => Promise<void>,
): Promise<void> {
  await writePlaintextFile(tomb, HEADER_PATH, JSON.stringify(header), check);
  await persist();
  await hydrateAndMigrateTombOnUnlock(tomb);
  await loadPreferences();
  check();
}
