/** The vault store's snapshot: what every surface reads about the open session. */

import type {
  Folder,
  VaultEnvironments,
  VaultHeader,
  VaultItem,
} from "@opensesame/vault-core";
import { isGuestVaultId } from "../guest-vault-id.js";
import type { TrustedUnlockView } from "../trusted-unlock.js";
import type { VaultPrefs } from "./prefs.js";

export type VaultStatus = "empty" | "locked" | "unlocked";

export type VaultState = {
  status: VaultStatus;
  /**
   * The tomb this session reads and writes — a project id, `personal`,
   * `guest`, an isolated `guest_<uuid>`, or the scratch tomb a guest or decoy runs in beside a sealed
   * guest. Every storage operation keys on this. Display and road identity
   * read `presentedTomb(tomb)` (the scratch tomb reads as `guest`); that alias
   * is never a storage key — a scratch session must not reach the sealed guest.
   */
  tomb: string;
  /** True while a guest session holds the key: never wrapped to disk. */
  guest: boolean;
  /**
   * True while the guest session is a duress decoy: isolated like any guest,
   * but drawn as the vault the unlock screen was showing, so nothing on screen
   * says which road opened it.
   */
  decoy?: boolean;
  header: VaultHeader | null;
  /** Accounts read with the methods of their credentials (ADR 0179). */
  items: VaultItem[];
  /** The items as sealed: an account holds no methods, its credentials sit beside it. */
  rawItems?: readonly VaultItem[];
  folders: Folder[];
  /** The vault's environments by name, removals as markers (ADR 0194). */
  environments?: VaultEnvironments | undefined;
  prefs: VaultPrefs;
  /** Milliseconds until auto-lock, or null when no timer is armed. */
  lockedOutUntil: number | null;
  failedAttempts: number;
  /** Primary unlocked; second step enrolled but not yet confirmed. */
  awaitingSecondStep: boolean;
  /** Primary and second steps passed; a trusted-contact quorum must approve. */
  trustedUnlock?: TrustedUnlockView | null;
  /** False when storage is tab-only (no durable OPFS). */
  durable: boolean;
};

/**
 * Where the session's guest flag is read from. `vault/store.ts` binds the
 * session store here as it loads, so readers such as `guest-isolation.ts`
 * stay leaf modules — importing the store statically closes an import cycle
 * (ADR 0133). Before the store loads there is no session, and it reads false.
 */
let readGuestSession: () => boolean = () => false;

/** Bind the session store's guest flag and return the store, for `export const vaultStore = …`. */
export function bindGuestSessionStore<
  T extends {
    getSnapshot(): { guest?: boolean; status?: string; tomb?: string };
  },
>(store: T): T {
  // A protected guest vault is still a guest session once it is unlocked.
  readGuestSession = () => {
    const snapshot = store.getSnapshot();
    return (
      snapshot.guest === true ||
      (snapshot.status === "unlocked" && isGuestVaultId(snapshot.tomb ?? null))
    );
  };
  return store;
}

/** True while the unlocked session is the isolated guest road. */
export function guestSessionActive(): boolean {
  return readGuestSession();
}
