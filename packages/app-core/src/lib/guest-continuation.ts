import { host } from "../host.js";
import { maybePage, sessionStore } from "../ports.js";
import { isSealedAtRest } from "./at-rest/cipher.js";
import { GUEST_CONTINUATION_KEY as KEY } from "./guest-continuation-key.js";
import { ensureGuestSignOutOwner } from "./guest-return-barrier.js";
import {
  GUEST_SIGN_OUT_FIRST,
  GUEST_SIGN_OUT_UNVERIFIED,
} from "./guest-signout-copy.js";
import { isIsolatedGuestVaultId } from "./guest-vault-id.js";
import type { GuestSessionPerson } from "./local-guest.js";

export type GuestContinuation = {
  kind: "github" | "vercel";
  token: string;
  connectionId?: string;
  tomb: string;
  person: GuestSessionPerson;
  origin: string;
  pathname: string;
  deadline: number;
  /** A bearer-only sign-in needs to be repeated after full-page navigation. */
  identityExpected?: boolean;
  identity: {
    issuerOrigin: string;
    principalId: string;
    sessionId: string;
  } | null;
};

export function saveGuestContinuation(value: GuestContinuation): void {
  ensureGuestSignOutOwner();
  sessionStore().setItem(KEY, JSON.stringify(value));
}

export function hasGuestContinuation(tomb: string, token: string): boolean {
  try {
    const value: GuestContinuation | null = JSON.parse(
      sessionStore().getItem(KEY) ?? "null",
    );
    return Boolean(
      value &&
        value.tomb === tomb &&
        value.token === token &&
        value.deadline > Date.now(),
    );
  } catch {
    return false;
  }
}

export function forgetGuestContinuation(tomb?: string): void {
  try {
    if (tomb) {
      const raw = sessionStore().getItem(KEY);
      if (!raw || JSON.parse(raw).tomb !== tomb) return;
    }
    sessionStore().removeItem(KEY);
  } catch {
    /* no tab-owned continuation */
  }
}

function matchesCallback(
  value: GuestContinuation,
  query: URLSearchParams,
): boolean {
  if (value.kind === "github")
    return (
      (query.get("github_app_state") ?? query.get("state")) === value.token &&
      Boolean(query.get("github_app_code") ?? query.get("code"))
    );
  if (value.kind === "vercel")
    return (
      query.get("guest_return") === value.token &&
      query.get("connection") === value.connectionId
    );
  return false;
}

function validPerson(person: GuestSessionPerson | undefined): boolean {
  return Boolean(
    person && typeof person.id === "string" && typeof person.name === "string",
  );
}

/** Read a tab's issuance even after its callback URL has been cleared. */
export function parseGuestContinuation(
  raw: string | null,
): GuestContinuation | null {
  try {
    if (!raw) return null;
    const value: GuestContinuation = JSON.parse(raw);
    if (
      !value ||
      !isIsolatedGuestVaultId(value.tomb) ||
      !validPerson(value.person) ||
      (value.kind !== "github" && value.kind !== "vercel") ||
      typeof value.token !== "string" ||
      !value.token ||
      !Number.isFinite(value.deadline) ||
      typeof value.origin !== "string" ||
      typeof value.pathname !== "string"
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

export function readStoredGuestContinuation(): GuestContinuation | null {
  try {
    return parseGuestContinuation(sessionStore().getItem(KEY));
  } catch {
    return null;
  }
}

/** A failed read is distinct from a browser with no pending return. */
export function inspectStoredGuestContinuation():
  | { kind: "none" }
  | { kind: "unavailable" }
  | { kind: "present"; value: GuestContinuation } {
  try {
    // Inspect physical presence first: the storage adapter removes unsealed
    // bytes on read, but a corrupt continuation must remain recoverable.
    const physical = host().storage?.session?.getItem(KEY) ?? null;
    if (physical !== null && !isSealedAtRest(physical))
      return { kind: "unavailable" };
    const raw = sessionStore().getItem(KEY);
    if (!raw)
      return physical !== null ? { kind: "unavailable" } : { kind: "none" };
    const value = parseGuestContinuation(raw);
    return value ? { kind: "present", value } : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}

/** Refuse a new sign-in until any earlier guest return has been revoked. */
export function requireGuestReturnCleared(allowUnavailable = false): void {
  const previous = inspectStoredGuestContinuation();
  if (previous.kind === "unavailable" && !allowUnavailable)
    throw new Error(GUEST_SIGN_OUT_UNVERIFIED);
  if (previous.kind === "present") throw new Error(GUEST_SIGN_OUT_FIRST);
}

/** Only the original same-tab provider callback can reopen a guest actor. */
export function peekGuestContinuation(): GuestContinuation | null {
  const value = readStoredGuestContinuation();
  const page = maybePage();
  if (
    !value ||
    !page ||
    Date.now() >= value.deadline ||
    value.origin !== page.location.origin ||
    value.pathname !== page.location.pathname
  )
    return null;
  return matchesCallback(value, new URLSearchParams(page.location.search))
    ? value
    : null;
}
