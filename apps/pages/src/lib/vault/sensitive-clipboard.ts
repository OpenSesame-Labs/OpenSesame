import {
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import { overlapCast } from "@opensesame/os-domain";

export type CopyResult = "copied" | "unavailable";

export const CLIPBOARD_READ_NOTICE = {
  id: "clipboard-clear",
  tone: "info" as const,
  title: "Clipboard",
  body: "Reading the clipboard to clear a secret this vault copied, if it is still the one there.",
};

const CLEAR_FAILED_NOTICE = {
  id: "clipboard-clear-failed",
  tone: "warn" as const,
  title: "Clipboard",
  body: "The browser could not clear the copied secret. Replace the clipboard contents yourself.",
};

type Copy = { value: string; expiresAt: number | null };
let lastCopied: Copy | null = null;
let pendingTimer: number | null = null;
let lockGeneration = 0;
let clipboardWriteInFlight: Promise<void> | null = null;
let clipboardReadsInFlight = 0;

/** Serialize writes, which the browser cannot cancel once started. */
function tryStartClipboardWrite(): (() => void) | null {
  if (clipboardWriteInFlight !== null) return null;
  let resolve: () => void = () => undefined;
  clipboardWriteInFlight = new Promise<void>((done) => {
    resolve = done;
  });
  return () => {
    clipboardWriteInFlight = null;
    resolve();
  };
}

function cancelTimer(): void {
  if (pendingTimer !== null) window.clearTimeout(pendingTimer);
  pendingTimer = null;
}

function schedule(copy: Copy): void {
  cancelTimer();
  if (copy.expiresAt === null) return;
  pendingTimer = window.setTimeout(
    () => {
      pendingTimer = null;
      void clearIfOurs(copy, "timer");
    },
    Math.max(0, copy.expiresAt - Date.now()),
  );
}

async function readIsGranted(): Promise<boolean> {
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

/** Preserve the explanation when locking clears the rest of the notice tray. */
export function restoreClipboardReadNotice(): void {
  if (clipboardReadsInFlight > 0) setStatusNotice(CLIPBOARD_READ_NOTICE);
}

async function readClipboard(): Promise<
  { ok: true; value: string } | { ok: false }
> {
  clipboardReadsInFlight += 1;
  setStatusNotice(CLIPBOARD_READ_NOTICE);
  try {
    return { ok: true, value: await navigator.clipboard.readText() };
  } catch {
    return { ok: false };
  } finally {
    clipboardReadsInFlight -= 1;
    if (clipboardReadsInFlight === 0) dismissNotice(CLIPBOARD_READ_NOTICE.id);
  }
}

async function clearTrackedCopy(
  copy: Copy,
  mode: "timer" | "lock",
): Promise<boolean> {
  const finishWrite = tryStartClipboardWrite();
  if (!finishWrite) return false;
  let cleared = false;
  try {
    await navigator.clipboard.writeText("");
    cleared = true;
  } catch {
    // Timed failures remain tracked for a later lock attempt.
  } finally {
    if (lastCopied === copy) {
      if (cleared || mode === "lock") lastCopied = null;
      if (cleared) dismissNotice(CLEAR_FAILED_NOTICE.id);
      else setStatusNotice(CLEAR_FAILED_NOTICE);
    }
    finishWrite();
  }
  return true;
}

async function clearIfOurs(copy: Copy, mode: "timer" | "lock"): Promise<void> {
  while (lastCopied === copy) {
    if (clipboardWriteInFlight !== null) {
      await clipboardWriteInFlight;
      continue;
    }
    const granted = await readIsGranted();
    if (lastCopied !== copy) return;
    if (clipboardWriteInFlight !== null) continue;
    if (!granted && mode === "timer") {
      setStatusNotice(CLEAR_FAILED_NOTICE);
      return;
    }
    if (granted) {
      const current = await readClipboard();
      if (lastCopied !== copy) return;
      // A copy started during the read: await its write and recheck ownership.
      if (clipboardWriteInFlight !== null) continue;
      if (!current.ok && mode === "timer") {
        setStatusNotice(CLEAR_FAILED_NOTICE);
        return;
      }
      if (current.ok && current.value !== copy.value) {
        lastCopied = null;
        dismissNotice(CLEAR_FAILED_NOTICE.id);
        return;
      }
    }
    // On lock, unavailable or failed reads keep the existing blind-clear
    // fallback. The reservation prevents it racing an in-app copy.
    if (await clearTrackedCopy(copy, mode)) return;
  }
}

/** Called on lock; a write already in flight is cleaned up when it completes. */
export function clearCopiedSecret(): void {
  lockGeneration += 1;
  cancelTimer();
  if (lastCopied) void clearIfOurs(lastCopied, "lock");
}

/** Copy once, then attempt to clear only this copy after the chosen delay. */
export async function copySecret(
  value: string,
  clearAfterSeconds: number,
): Promise<CopyResult> {
  if (!navigator.clipboard?.writeText) return "unavailable";
  const finishWrite = tryStartClipboardWrite();
  if (!finishWrite) return "unavailable";
  const startedAtLockGeneration = lockGeneration;
  let current: Copy;
  try {
    await navigator.clipboard.writeText(value);
    current = {
      value,
      expiresAt:
        clearAfterSeconds > 0 ? Date.now() + clearAfterSeconds * 1000 : null,
    };
    lastCopied = current;
    cancelTimer();
    if (startedAtLockGeneration === lockGeneration) schedule(current);
  } catch {
    // The previous copy and its existing timer remain tracked.
    return "unavailable";
  } finally {
    finishWrite();
  }
  if (startedAtLockGeneration !== lockGeneration) {
    await clearIfOurs(current, "lock");
    return "unavailable";
  }
  dismissNotice(CLEAR_FAILED_NOTICE.id);
  return "copied";
}
