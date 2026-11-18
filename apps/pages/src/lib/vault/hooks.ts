import { trustedHideRetires } from "@opensesame/app-core/lib/document-lifecycle.js";
import { endSession } from "@opensesame/app-core/lib/identity.js";
import { clearNotices } from "@opensesame/app-core/lib/notices.js";
import { clearStagedClaimTokens } from "@opensesame/app-core/lib/queue.js";
import {
  type VaultState,
  vaultStore,
} from "@opensesame/app-core/lib/vault/store.js";
import { packsVersion, subscribePacks } from "@opensesame/vault-item-types";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { lockAfterDraft } from "../sw-update-guard.js";
import {
  applyTheme,
  hasStoredTheme,
  loadTheme,
  setTheme,
  useThemePreference,
} from "../theme.js";
import {
  type CopyResult,
  clearCopiedSecret as clearClipboard,
  copySecret,
  restoreClipboardReadNotice,
} from "./sensitive-clipboard.js";

export type { CopyResult } from "./sensitive-clipboard.js";
export { CLIPBOARD_READ_NOTICE } from "./sensitive-clipboard.js";

function useVaultDefault(): VaultState {
  // A built-in type switched on or off changes how every item draws, and the
  // registry is module state no vault snapshot moves with (ADR 0165): hearing
  // it here re-renders whatever reads the vault, so an item of a type that has
  // just arrived stops reading "type not installed" without a reload.
  useSyncExternalStore(subscribePacks, packsVersion);
  return useSyncExternalStore(vaultStore.subscribe, vaultStore.getSnapshot);
}

function useVaultStoreDefault() {
  return vaultStore;
}

export const vaultHooksSeams = {
  useVault: useVaultDefault,
  useVaultStore: useVaultStoreDefault,
  useSessionGuards: useSessionGuardsDefault,
  useTheme: useThemeDefault,
  useCopySecret: useCopySecretDefault,
  clearCopiedSecret: clearCopiedSecretDefault,
};

export function useVault(): VaultState {
  return vaultHooksSeams.useVault();
}

export function useVaultStore() {
  return vaultHooksSeams.useVaultStore();
}

/** Keep the idle clock honest and lock on tab hide when the user asked for it. */
function useSessionGuardsDefault(): void {
  const { prefs, status } = useVault();

  // Locking drops in-memory vault keys and clears secrets that left the vault
  // (clipboard, staged claim tokens). An ownership claim's stash is purged by
  // the core (`bindClaimLockReset`); a drop's key stays in memory for that
  // sitting. Identity stays signed in unless the operator opted into "sign
  // out on lock" — idle vault lock must not kick them out of every plane.
  useEffect(
    () =>
      vaultStore.onLock(() => {
        clearCopiedSecret();
        clearStagedClaimTokens();
        clearNotices();
        restoreClipboardReadNotice();
        if (vaultStore.getSnapshot().prefs.signOutOnLock) {
          endSession();
        }
      }),
    [],
  );

  useEffect(() => {
    if (status !== "unlocked") return;
    const touch = () => vaultStore.touch();
    // Reading/scrolling counts as activity — not only clicks and keypresses.
    const events = [
      "pointerdown",
      "pointermove",
      "keydown",
      "scroll",
      "wheel",
      "touchstart",
      "focus",
    ] as const;
    let moveArmed = true;
    const onMove = () => {
      if (!moveArmed) return;
      moveArmed = false;
      touch();
      window.setTimeout(() => {
        moveArmed = true;
      }, 15_000);
    };
    for (const event of events) {
      if (event === "pointermove") {
        window.addEventListener(event, onMove, {
          capture: true,
          passive: true,
        });
      } else {
        window.addEventListener(event, touch, { capture: true, passive: true });
      }
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") touch();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      for (const event of events) {
        if (event === "pointermove") {
          window.removeEventListener(event, onMove, true);
        } else {
          window.removeEventListener(event, touch, true);
        }
      }
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [status]);

  useEffect(() => {
    if (status !== "unlocked" || !prefs.lockOnHide) return;
    const onHide = (event: Event) => {
      if (
        trustedHideRetires({
          trusted: event.isTrusted,
          hidden: document.visibilityState === "hidden",
          lockOnHide: prefs.lockOnHide,
          unlocked: status === "unlocked",
        })
      ) {
        lockAfterDraft(vaultStore);
      }
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [status, prefs.lockOnHide]);
}

/** Wipe anything this app copied. Called on vault lock. */
function clearCopiedSecretDefault(): void {
  clearClipboard();
}

/**
 * Copy a secret and attempt to clear it after the configured delay or on lock.
 */
function useCopySecretDefault(): (value: string) => Promise<CopyResult> {
  const { prefs } = useVault();
  return useCallback(
    (value: string) => copySecret(value, prefs?.clipboardClearSeconds ?? 0),
    [prefs?.clipboardClearSeconds],
  );
}

function useThemeDefault(): void {
  const { status, prefs } = useVault();
  const theme = useThemePreference();
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  useEffect(() => {
    if (status !== "unlocked") return;
    // First unlock after this feature: adopt sealed prefs when device has none.
    if (!hasStoredTheme()) {
      setTheme(prefs.theme);
      return;
    }
    const device = loadTheme();
    if (prefs.theme !== device) vaultStore.setPrefs({ theme: device });
  }, [status, prefs.theme]);
}

export function useSessionGuards(): void {
  vaultHooksSeams.useSessionGuards();
}

export function useTheme(): void {
  vaultHooksSeams.useTheme();
}

export function useCopySecret(): (value: string) => Promise<CopyResult> {
  return vaultHooksSeams.useCopySecret();
}

export function clearCopiedSecret(): void {
  vaultHooksSeams.clearCopiedSecret();
}
