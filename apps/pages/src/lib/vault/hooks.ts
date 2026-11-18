import { trustedHideRetires } from "@opensesame/app-core/lib/document-lifecycle.js";
import { endSession } from "@opensesame/app-core/lib/identity.js";
import {
  clearNotices,
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import { clearStagedClaimTokens } from "@opensesame/app-core/lib/queue.js";
import {
  type VaultState,
  vaultStore,
} from "@opensesame/app-core/lib/vault/store.js";
import { overlapCast } from "@opensesame/os-domain";
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
        if (clipboardReadsInFlight > 0) {
          setStatusNotice(CLIPBOARD_READ_NOTICE);
        }
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

export type CopyResult = "copied" | "unavailable";

/**
 * Said in the tray before `readText`, which otherwise raises a browser
 * permission prompt with no reason (ADR 0163). Present for the whole read.
 */
export const CLIPBOARD_READ_NOTICE = {
  id: "clipboard-clear",
  tone: "info" as const,
  title: "Clipboard",
  body: "Reading the clipboard to clear a secret this vault copied, if it is still the one there.",
};

// Identity matters even when two copies have the same value: an old async
// read or permission check must not retire a newer copy's lock-time cleanup.
type CopiedSecret = { value: string };
let lastCopied: CopiedSecret | null = null;
let pendingClear: number | null = null;
let lockGeneration = 0;
let clipboardWriteInFlight: Promise<void> | null = null;
let clipboardReadsInFlight = 0;

/** Reserve the clipboard until a write settles; callers may retry when busy. */
function tryStartClipboardWrite(): (() => void) | null {
  if (clipboardWriteInFlight !== null) return null;
  let resolve: () => void = () => undefined;
  const pending = new Promise<void>((done) => {
    resolve = done;
  });
  clipboardWriteInFlight = pending;
  return () => {
    clipboardWriteInFlight = null;
    resolve();
  };
}

async function clipboardReadIsGranted(): Promise<boolean> {
  if (!navigator.permissions?.query) return false;
  try {
    const status = await navigator.permissions.query({
      name: overlapCast<"clipboard-read", PermissionName>("clipboard-read"),
    });
    return status.state === "granted";
  } catch {
    return false;
  }
}

async function clearIfOurs(
  copied: CopiedSecret,
  mode: "timer" | "lock",
): Promise<void> {
  while (lastCopied === copied) {
    if (clipboardWriteInFlight !== null) {
      await clipboardWriteInFlight;
      continue;
    }

    const readGranted = await clipboardReadIsGranted();
    if (lastCopied !== copied) return;
    if (clipboardWriteInFlight !== null) continue;
    if (!readGranted && mode === "timer") {
      // A timed clear must not surprise someone mid-navigation with a read prompt.
      return;
    }

    if (readGranted) {
      // The tray sentence is up before the read and leaves when it finishes.
      let current: string | null = null;
      let readFailed = false;
      clipboardReadsInFlight += 1;
      setStatusNotice(CLIPBOARD_READ_NOTICE);
      try {
        current = await navigator.clipboard.readText();
      } catch {
        readFailed = true;
      } finally {
        clipboardReadsInFlight -= 1;
        if (clipboardReadsInFlight === 0) {
          dismissNotice(CLIPBOARD_READ_NOTICE.id);
        }
      }
      if (lastCopied !== copied) return;
      // A copy could have begun while readText was pending. Wait for it and
      // read again rather than acting on a snapshot from before that write.
      if (clipboardWriteInFlight !== null) continue;
      // A timed clear must not overwrite someone else's clipboard when we
      // cannot establish ownership. Keep tracking it for a later lock.
      if (readFailed && mode === "timer") return;
      if (!readFailed && current !== copied.value) {
        lastCopied = null;
        return;
      }
    }

    // On lock, unavailable or failed reads result in a best-effort clear. If
    // another application changed the clipboard, this can overwrite it.
    // Don't race an in-app copy: browser clipboard writes cannot be cancelled.
    const finishWrite = tryStartClipboardWrite();
    if (!finishWrite) continue;
    try {
      await navigator.clipboard.writeText("");
    } catch {
      /* clipboard unavailable — nothing further we can do */
    } finally {
      if (lastCopied === copied) lastCopied = null;
      finishWrite();
    }
    return;
  }
}

/** Wipe anything this app copied. Called on vault lock. */
function clearCopiedSecretDefault(): void {
  // A clipboard write may still be awaiting the browser when lock fires.
  // That write must not publish an untracked secret after this clear.
  lockGeneration += 1;
  if (pendingClear !== null) {
    window.clearTimeout(pendingClear);
    pendingClear = null;
  }
  const copied = lastCopied;
  if (copied === null) return;
  void clearIfOurs(copied, "lock");
}

/**
 * Copy a secret and schedule a best-effort clipboard clear on timer or lock.
 */
function useCopySecretDefault(): (value: string) => Promise<CopyResult> {
  const { prefs } = useVault();
  return useCallback(
    async (value: string) => {
      if (!navigator.clipboard?.writeText) return "unavailable";
      const finishWrite = tryStartClipboardWrite();
      if (!finishWrite) return "unavailable";
      const startedAtLockGeneration = lockGeneration;
      let copied: CopiedSecret;
      try {
        await navigator.clipboard.writeText(value);
        copied = { value };
        lastCopied = copied;
        if (pendingClear !== null) window.clearTimeout(pendingClear);
        pendingClear = null;
        const clearAfter = prefs?.clipboardClearSeconds ?? 0;
        if (startedAtLockGeneration === lockGeneration && clearAfter > 0) {
          pendingClear = window.setTimeout(() => {
            pendingClear = null;
            void clearIfOurs(copied, "timer");
          }, clearAfter * 1000);
        }
      } catch {
        return "unavailable";
      } finally {
        finishWrite();
      }
      if (startedAtLockGeneration !== lockGeneration) {
        await clearIfOurs(copied, "lock");
        return "unavailable";
      }
      return "copied";
    },
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
