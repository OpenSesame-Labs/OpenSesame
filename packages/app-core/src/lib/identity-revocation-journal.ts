/**
 * Durable record that an Identity cookie revocation is still owed.
 *
 * Sign-out ends the in-memory session at once, but the HttpOnly cookie only
 * stops acting when the Identity service confirms the revoke. Until then a
 * reload, or another tab, could resume that cookie. Each owed revoke is one
 * entry, sealed under the device's at-rest key through the ports' local store
 * (ADR 0149), naming only the Identity API base: no bearer, cookie value or
 * principal is ever written (a reload still deliberately loses the bearer).
 *
 * With no durable at-rest key (session-only mode) the sealed store holds the
 * entry in this document's memory, so the fence still holds here but cannot
 * outlive the tab; that residual is recorded as unproved for AUTH-C1.
 */
import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { host } from "../host.js";
import { lockManager, maybeLocalStore } from "../ports.js";
import { atRestKeyNow } from "./at-rest/key.js";

export const IDENTITY_REVOCATION_PREFIX = "opensesame.identity.revoke.v1.";
/** One cross-document lock so two tabs never race the same owed revoke. */
const SWEEP_LOCK = "opensesame:identity-revocation";

export type PendingRevocation = { key: string; issuerBase: string };

/** Entries this document staged; a memory-only seal never reaches disk. */
const memory = new Map<string, string>();

export class RevocationJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevocationJournalError";
  }
}

function journalKeys(): string[] {
  const found = new Set(memory.keys());
  const physical = host().storage?.local;
  if (physical) {
    for (let index = 0; index < physical.length; index += 1) {
      const key = physical.key(index);
      if (key?.startsWith(IDENTITY_REVOCATION_PREFIX)) found.add(key);
    }
  }
  return [...found];
}

function parse(key: string, raw: string): PendingRevocation {
  const value: BoundaryValue = JSON.parse(raw);
  if (!isJsonObject(value) || !isString(value.issuerBase))
    throw new RevocationJournalError("Pending sign-out could not be read.");
  return { key, issuerBase: value.issuerBase };
}

/** Null once the entry is gone; throws when it exists but cannot be opened. */
function readEntry(key: string): PendingRevocation | null {
  const held = memory.get(key);
  if (held !== undefined) return parse(key, held);
  const raw = maybeLocalStore()?.getItem(key) ?? null;
  return raw === null ? null : parse(key, raw);
}

/**
 * Owed revokes for `base`. An entry that cannot be opened names no service, so
 * it is owed by whichever service is configured now: fail closed, never open.
 */
export function pendingRevocationsFor(base: string): PendingRevocation[] {
  const owed: PendingRevocation[] = [];
  for (const key of journalKeys()) {
    let entry: PendingRevocation | null;
    try {
      entry = readEntry(key);
    } catch {
      entry = { key, issuerBase: base };
    }
    if (entry?.issuerBase === base) owed.push(entry);
  }
  return owed;
}

export function revocationPendingFor(base: string): boolean {
  try {
    return pendingRevocationsFor(base).length > 0;
  } catch {
    // Unreadable Web Storage cannot prove that no sign-out is owed.
    return true;
  }
}

/**
 * Record an owed cookie revoke before the session is forgotten. `saved` is
 * false when a durable key is loaded but the sealed entry did not reach
 * storage, so the caller reports sign-out incomplete instead of implying it
 * was saved; the entry still fences this document from memory.
 */
/** A staged entry; `key` is absent on a host with no Web Storage at all. */
export type StagedRevocation = { key: string | undefined; saved: boolean };

export function stageRevocation(issuerBase: string): StagedRevocation {
  // A host with no Web Storage (a worker, Node) has no document to reload.
  const store = maybeLocalStore();
  if (!store) return { key: undefined, saved: true };
  const key = IDENTITY_REVOCATION_PREFIX + crypto.randomUUID();
  const value = JSON.stringify({ issuerBase });
  memory.set(key, value);
  try {
    store.setItem(key, value);
    if (atRestKeyNow()?.durable !== true) return { key, saved: true };
    if (host().storage?.local?.getItem(key) == null)
      return { key, saved: false };
  } catch {
    return { key, saved: false };
  }
  memory.delete(key);
  return { key, saved: true };
}

export function forgetRevocation(key: string): void {
  memory.delete(key);
  try {
    maybeLocalStore()?.removeItem(key);
  } catch {
    // A store that refuses removal keeps the entry, which stays fail-closed.
  }
}

/**
 * Send each owed revoke for `base` once, under the cross-document lock, and
 * forget an entry only after the service confirms it. A second document that
 * waited for the lock re-reads the journal and finds the entry already gone.
 * Returns whether nothing is owed for `base` afterwards.
 */
export async function sweepRevocations(
  base: string,
  revoke: (key: string) => Promise<Response>,
): Promise<boolean> {
  if (!revocationPendingFor(base)) return true;
  const run = async (): Promise<boolean> => {
    for (const entry of pendingRevocationsFor(base)) {
      let confirmed = false;
      try {
        confirmed = (await revoke(entry.key)).ok;
      } catch {
        confirmed = false;
      }
      if (!confirmed) return false;
      forgetRevocation(entry.key);
    }
    return !revocationPendingFor(base);
  };
  try {
    const locks = lockManager();
    return locks ? await locks.request(SWEEP_LOCK, run) : await run();
  } catch {
    return false;
  }
}

/** Drop this document's memory-only entries (tests). */
export function forgetRevocationMemoryForTest(): void {
  memory.clear();
}
