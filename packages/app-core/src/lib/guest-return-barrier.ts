/** A storage-backed fence for sign-outs whose guest return is not yet revoked. */
import { maybeLocalStore, maybeSessionStore } from "../ports.js";
import { hasPendingBoundRevocation } from "./identity-revocation-journal.js";

const SESSION_KEY = "opensesame.guest.signout-barrier-owner.v1";
const ACTIVE_KEY = "opensesame.guest.signout-barrier-active.v1";
const LOCAL_PREFIX = "opensesame.guest.signout-barrier.";
let owner: string | null = null;
let ownsMarker = false;
let inMemory = false;
let cleanupIncomplete = false;

/** Establish a stable tab identity while session storage is available. */
export function ensureGuestSignOutOwner(): void {
  const storage = maybeSessionStore();
  if (!storage) throw new Error("Session storage is unavailable.");
  owner ??= storage.getItem(SESSION_KEY) ?? crypto.randomUUID();
  storage.setItem(SESSION_KEY, owner);
}

/** Record a fence before locking, including when the continuation cannot be read. */
export function markGuestSignOutBarrier(cleanupFailed = false): void {
  const first = !ownsMarker;
  if (!ownsMarker) {
    // Session storage may be cloned into another tab; marker ownership is
    // valid only in the document that created this fresh random identifier.
    owner = crypto.randomUUID();
    ownsMarker = true;
    try {
      maybeSessionStore()?.setItem(SESSION_KEY, owner);
    } catch {
      // The local marker still fences other documents.
    }
  }
  inMemory = true;
  // A new marker starts closed until every local sign-out action completes.
  cleanupIncomplete ||= cleanupFailed || first;
  const state = cleanupIncomplete ? "cleanup" : "pending";
  try {
    maybeSessionStore()?.setItem(ACTIVE_KEY, state);
  } catch {
    // The local marker still fences other tabs and reloads.
  }
  try {
    maybeLocalStore()?.setItem(LOCAL_PREFIX + owner, state);
  } catch {
    // Keep the in-memory fence until a retry can access storage.
  }
}

/** Called only while the exact return's exclusive lease is held and revoked. */
export function claimRevokedGuestBarrier(): boolean {
  if (ownsMarker) return true;
  try {
    const session = maybeSessionStore();
    const local = maybeLocalStore();
    const recovered = session?.getItem(SESSION_KEY);
    if (!recovered || !local) return false;
    const state = local.getItem(LOCAL_PREFIX + recovered);
    if (state === "pending") {
      owner = recovered;
      ownsMarker = true;
      return true;
    }
    if (state !== null) return false;
    // A second restored document may have finished this exact sign-out first.
    session?.removeItem(ACTIVE_KEY);
    inMemory = false;
    return !guestSignOutBarrierActive();
  } catch {
    return false;
  }
}

/** A marker in any tab blocks entry until its owner completes sign-out. */
export function guestSignOutBarrierActive(): boolean {
  try {
    if (hasPendingBoundRevocation()) return true;
  } catch {
    // Preserve any barrier already observed when storage becomes unavailable.
  }
  try {
    const session = maybeSessionStore();
    owner ??= session?.getItem(SESSION_KEY) ?? null;
    const state = session?.getItem(ACTIVE_KEY);
    if (state) inMemory = true;
    if (state === "cleanup") cleanupIncomplete = true;
  } catch {
    // A fresh offline tab with no evidence of a sign-out remains usable.
  }
  try {
    const storage = maybeLocalStore();
    if (storage)
      for (let index = 0; index < storage.length; index += 1)
        if (storage.key(index)?.startsWith(LOCAL_PREFIX)) return true;
  } catch {
    // Preserve a barrier already observed in this document.
  }
  return inMemory;
}

/** Cleanup failures are authority state, independent of dismissible notices. */
export function guestSignOutCleanupIncomplete(): boolean {
  guestSignOutBarrierActive();
  if (cleanupIncomplete) return true;
  try {
    const storage = maybeLocalStore();
    if (storage)
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key?.startsWith(LOCAL_PREFIX) && storage.getItem(key) === "cleanup")
          return true;
      }
  } catch {
    return true;
  }
  return false;
}

/** Record that this tab retried and completed every sign-out cleanup. */
export function completeGuestSignOutCleanup(): boolean {
  if (!guestSignOutBarrierActive()) return true;
  if (!owner || !ownsMarker) return false;
  try {
    maybeSessionStore()?.setItem(ACTIVE_KEY, "pending");
    maybeLocalStore()?.setItem(LOCAL_PREFIX + owner, "pending");
    cleanupIncomplete = false;
    return !guestSignOutCleanupIncomplete();
  } catch {
    return false;
  }
}

/** Only the tab that created a marker may remove it. */
export function clearGuestSignOutBarrier(): boolean {
  if (!guestSignOutBarrierActive()) return true;
  if (!owner || !ownsMarker || guestSignOutCleanupIncomplete()) return false;
  try {
    const session = maybeSessionStore();
    const local = maybeLocalStore();
    session?.removeItem(ACTIVE_KEY);
    local?.removeItem(LOCAL_PREFIX + owner);
    inMemory = false;
    ownsMarker = false;
    return !guestSignOutBarrierActive();
  } catch {
    return false;
  }
}
