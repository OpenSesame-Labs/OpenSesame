import { isGuestVaultId } from "../../guest-vault-id.js";
/**
 * STORE-E — vault store surface for duress activation coordination.
 */

import type { VaultHeader } from "@opensesame/vault-core";
import { discardTombCaches } from "../../vault/tomb-migration.js";

export type DuressVaultActivationHost = Readonly<{
  activeTomb: () => string;
  isGuestOrEphemeral: () => boolean;
  isOnboarding: () => boolean;
  flushPendingWrites: () => Promise<void>;
  cancelPendingOps: () => void;
  discardCaches: () => void;
  sessionGeneration: () => number;
}>;

export function createDuressVaultActivationHost(input: {
  activeTomb: () => string;
  ephemeral: () => boolean;
  header: () => VaultHeader | null;
  vaultKey: () => CryptoKey | null;
  flushPendingWrites: () => Promise<void>;
  cancelPendingOps: () => void;
  sessionGeneration: () => number;
}): DuressVaultActivationHost {
  return {
    activeTomb: input.activeTomb,
    isGuestOrEphemeral: () =>
      input.ephemeral() || isGuestVaultId(input.activeTomb()),
    isOnboarding: () =>
      input.header() === null &&
      !input.ephemeral() &&
      input.vaultKey() === null,
    flushPendingWrites: input.flushPendingWrites,
    cancelPendingOps: input.cancelPendingOps,
    discardCaches: () => discardTombCaches(),
    sessionGeneration: input.sessionGeneration,
  };
}
