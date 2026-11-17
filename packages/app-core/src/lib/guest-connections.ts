/**
 * Connectors a guest actually connected in this tab, scoped to the active
 * guest principal. Claims must not survive across guest-1 → guest-2 — each
 * unclaimed principal authorizes its own connectors.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { maybeSessionStore } from "../ports.js";
import { isGuestSession } from "./guest-isolation.js";
import {
  activeGuestEpoch,
  captureGuestSessionContext,
  isLocalOnlyGuest,
} from "./guest-session-context.js";
import { readGuestSessionPerson } from "./local-guest.js";

const KEY = "opensesame.guest.connections.v2";

function readMap(): Map<string, string[]> {
  const store = maybeSessionStore();
  const out = new Map<string, string[]>();
  if (!store) return out;
  const raw = store.getItem(KEY);
  if (!raw) return out;
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    if (!isJsonObject(parsed)) return out;
    for (const [principalId, ids] of Object.entries(parsed)) {
      if (!Array.isArray(ids)) continue;
      const cleaned: string[] = [];
      for (const id of ids) {
        if (!isString(id)) continue;
        const trimmed = id.trim();
        if (trimmed.length > 0) cleaned.push(trimmed);
      }
      if (cleaned.length > 0) out.set(principalId, cleaned);
    }
    return out;
  } catch {
    return out;
  }
}

function writeMap(map: Map<string, string[]>): void {
  const store = maybeSessionStore();
  if (!store) return;
  if (map.size === 0) {
    store.removeItem(KEY);
    return;
  }
  const plain: { [principalId: string]: string[] } = {};
  for (const [principalId, ids] of map) {
    plain[principalId] = ids;
  }
  store.setItem(KEY, JSON.stringify(plain));
}

function activeGuestId(): string | null {
  return readGuestSessionPerson()?.id ?? null;
}

export function guestClaimedConnections(): ReadonlySet<string> {
  if (isLocalOnlyGuest()) return new Set();
  const id = activeGuestId();
  if (!id) return new Set();
  return new Set(readMap().get(id) ?? []);
}

export function claimGuestConnection(id: string): void {
  const principalId = activeGuestId();
  if (!principalId) return;
  const trimmed = id.trim();
  if (!trimmed) return;
  const map = readMap();
  const next = map.get(principalId) ?? [];
  if (next.includes(trimmed)) return;
  map.set(principalId, [...next, trimmed]);
  writeMap(map);
}

/** A slow connector creation cannot become a different guest's connection. */
export async function createForCurrentGuest<T extends { connectionId: string }>(
  create: () => Promise<T>,
): Promise<T> {
  const guest = isGuestSession();
  const current = guest ? captureGuestSessionContext() : null;
  if (
    guest &&
    (isLocalOnlyGuest() || !current?.() || activeGuestEpoch() === null)
  )
    throw new Error("The guest session ended. Connect again.");
  const created = await create();
  if (guest) {
    if (!current?.() || !isGuestSession())
      throw new Error("The guest session ended. Connect again.");
    claimGuestConnection(created.connectionId);
  } else if (isGuestSession())
    throw new Error("The vault session changed. Connect again.");
  return created;
}

export function releaseGuestConnection(id: string): void {
  const principalId = activeGuestId();
  if (!principalId) return;
  const trimmed = id.trim();
  const map = readMap();
  const next = (map.get(principalId) ?? []).filter((item) => item !== trimmed);
  if (next.length === 0) {
    map.delete(principalId);
  } else {
    map.set(principalId, next);
  }
  writeMap(map);
}

/** Drop every guest's claims — used when minting a new guest session. */
export function clearGuestConnections(): void {
  writeMap(new Map());
}

export function visibleToGuest<T extends { connectionId: string }>(
  rows: readonly T[],
  guest: boolean,
): T[] {
  if (!guest) return [...rows];
  const claimed = guestClaimedConnections();
  return rows.filter((row) => claimed.has(row.connectionId));
}
