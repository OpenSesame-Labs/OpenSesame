/**
 * The pending-link marker: set while a verified upstream identity is
 * waiting to be attached, cleared the moment the link lands. Notices are
 * in-memory and die on reload; this marker is what lets the prompt be
 * raised again for the same pending link without inventing one on every
 * reload of an already-linked session.
 */

import { sessionStore } from "../ports.js";

const PENDING_LINK_KEY = "opensesame:federation:pending-link";

/**
 * Presence check for a storage key that fails closed.
 *
 * Private mode, a spent quota, or a browser configured to block site data all
 * make `sessionStorage` *throw* rather than return null. A probe that cannot
 * read must answer "absent", never "present" — answering "present" would make
 * a locked-vault sign-in look resumable when nothing was stored.
 *
 * Exported only so a test can assert it returns exactly `false` on a throwing
 * store. Every caller negates the result, so `undefined` would behave
 * identically at every call site and the failure would be invisible.
 */
export function storedKeyPresent(key: string): boolean {
  try {
    return sessionStore().getItem(key) !== null;
  } catch {
    return false;
  }
}

export function markPendingLink(): void {
  try {
    // A literal "1", not secret material: the rule guards against storing
    // something an XSS could exfiltrate, and the only thing this leaks is
    // that a link is pending, which the notice on screen already says.
    // ast-grep-ignore: ts-localstorage-set
    sessionStore().setItem(PENDING_LINK_KEY, "1");
  } catch {
    /* private mode — the in-memory notice is the only prompt then */
  }
}

export function clearPendingLink(): void {
  try {
    sessionStore().removeItem(PENDING_LINK_KEY);
  } catch {
    /* nothing was stored */
  }
}

/**
 * Drop a link that was waiting on an unlock. Sign-out calls this: the
 * assertion it would have attached is being forgotten in the same breath, so
 * a prompt to finish attaching it would name an account that is gone.
 */
export function forgetPendingLink(): void {
  clearPendingLink();
}

export function pendingLinkMarked(): boolean {
  return storedKeyPresent(PENDING_LINK_KEY);
}
