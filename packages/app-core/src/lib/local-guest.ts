/**
 * Guest principals are unclaimed and per-session — never a shared singleton.
 * Each Continue-as-guest mints a fresh id and a slug like `guest-1` — the
 * same label unlock menus, vault lists, and account chrome use. Legacy
 * `Guest N` / `guest@guest` / fixed UUID are recognized only so old
 * directories still classify as guest, not so new sessions reuse them.
 */

import {
  type BoundaryValue,
  type OrganizationRole,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { lockManager, sessionStore } from "../ports.js";
import { kvDelete, kvGet, kvRefresh, kvSet, kvSetDurable } from "./kv.js";

/** @deprecated Legacy singleton — detect only; never mint again. */
export const GUEST_PERSON_ID = "local_00000000-0000-4000-8000-000000000003";
/** @deprecated Legacy display name — detect only; never mint again. */
export const GUEST_PERSON_NAME = "guest@guest";

const GUEST_SESSION_KEY = "opensesame.guest.session-person";
const ISOLATED_SESSION_KEY = "opensesame.guest.isolated-person.v1";
/** Survives full navigations (GitHub App return); hydrated on cold boot. */
export const GUEST_ORDINAL_KEY = "opensesame.guest.ordinal.v1";
/** Durable copy of the tab's guest principal (OPFS); sessionStorage is a cache. */
export const GUEST_PERSON_KEY = "opensesame.guest.person.v1";

export type GuestSessionPerson = { id: string; name: string; localOnly?: true };
let isolatedPerson: GuestSessionPerson | null = null;
let isolatedActive = false;
let isolatedOwner: symbol | null = null;

const GUEST_NAME_LEGACY_RE = /^Guest ([1-9]\d*)$/;
const GUEST_NAME_SLUG_RE = /^guest-[1-9]\d*$/;

function readStoredGuestPerson(raw: string): GuestSessionPerson | null {
  let parsed: BoundaryValue;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isJsonObject(parsed)) return null;
  const id = parsed.id;
  const name = parsed.name;
  if (!isString(id) || !isString(name)) return null;
  if (!id.startsWith("local_")) return null;
  if (!/^local_[0-9a-f-]{36}$/.test(id) && !id.startsWith("local_guest_")) {
    return null;
  }
  if (
    !GUEST_NAME_LEGACY_RE.test(name) &&
    !GUEST_NAME_SLUG_RE.test(name) &&
    !name.startsWith("guest@")
  ) {
    return null;
  }
  const person: GuestSessionPerson = { id, name: guestNameSlug(name) };
  if (parsed.localOnly === true) person.localOnly = true;
  return person;
}

/** Canonical on-screen guest label — slug form, same everywhere. */
export function guestNameSlug(name: string): string {
  const legacy = GUEST_NAME_LEGACY_RE.exec(name.trim());
  if (legacy) return `guest-${legacy[1]}`;
  const trimmed = name.trim();
  if (GUEST_NAME_SLUG_RE.test(trimmed)) return trimmed;
  if (trimmed.toLowerCase() === "guest" || trimmed.startsWith("guest@")) {
    return "guest";
  }
  return trimmed;
}

/**
 * Label for the guest vault row and unlock chrome. Uses the tab's guest
 * slug when one exists; otherwise the generic `guest` road name.
 */
export function guestVaultLabel(): string {
  return readGuestSessionPerson()?.name ?? "guest";
}

function nextGuestOrdinal(): number {
  const raw = kvGet(GUEST_ORDINAL_KEY);
  let n = 0;
  if (isString(raw)) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) n = parsed;
  }
  const next = n + 1;
  kvSet(GUEST_ORDINAL_KEY, String(next));
  return next;
}

/** Prepare a fresh actor without replacing another guest's stored identity. */
export async function prepareIsolatedGuestPerson(): Promise<GuestSessionPerson> {
  const locks = lockManager();
  const mint = async () => {
    try {
      if (!locks) throw new Error("No shared ordinal lock.");
      await kvRefresh(GUEST_ORDINAL_KEY, 64);
      const current = Number.parseInt(kvGet(GUEST_ORDINAL_KEY) ?? "0", 10);
      const next =
        Number.isSafeInteger(current) && current >= 0 ? current + 1 : 1;
      await kvSetDurable(GUEST_ORDINAL_KEY, String(next));
      return { id: `local_${crypto.randomUUID()}`, name: `guest-${next}` };
    } catch {
      // The label is only display metadata. An unreadable disk must not block
      // an otherwise isolated, memory-only guest.
      const ordinal = (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) + 1;
      return { id: `local_${crypto.randomUUID()}`, name: `guest-${ordinal}` };
    }
  };
  return locks ? locks.request("opensesame-guest-ordinal", mint) : mint();
}

/** Activate only after the guest's vault has successfully acquired its lease. */
export function activateIsolatedGuestPerson(
  person: GuestSessionPerson | null,
): symbol {
  const owner = Symbol("guest-person");
  isolatedOwner = owner;
  isolatedActive = true;
  isolatedPerson = person;
  try {
    if (person)
      sessionStore().setItem(ISOLATED_SESSION_KEY, JSON.stringify(person));
    else sessionStore().removeItem(ISOLATED_SESSION_KEY);
  } catch {
    // An offline, memory-only guest remains available for this document.
  }
  return owner;
}

export function clearIsolatedGuestPerson(owner?: symbol): void {
  if (owner && isolatedOwner !== owner) return;
  isolatedPerson = null;
  isolatedActive = false;
  isolatedOwner = null;
  try {
    sessionStore().removeItem(ISOLATED_SESSION_KEY);
  } catch {
    // No persisted session was available.
  }
}

function persistSessionPerson(person: GuestSessionPerson): void {
  const raw = JSON.stringify(person);
  kvSet(GUEST_PERSON_KEY, raw);
  try {
    sessionStore().setItem(GUEST_SESSION_KEY, raw);
  } catch {
    /* private mode — OPFS/kv remains the surviving copy */
  }
}

/** Mint a new unclaimed guest principal (new id + `guest-N` slug). */
export function mintGuestSessionPerson(): GuestSessionPerson {
  clearGuestSessionPerson();
  const ordinal = nextGuestOrdinal();
  const person = {
    id: `local_${crypto.randomUUID()}`,
    name: `guest-${ordinal}`,
  };
  persistSessionPerson(person);
  return person;
}

/** Hold the ordinal on disk before the lock opens for the next tab. */
async function persistGuestOrdinal(): Promise<void> {
  const ordinal = kvGet(GUEST_ORDINAL_KEY);
  if (ordinal !== null) await kvSetDurable(GUEST_ORDINAL_KEY, ordinal);
}

/**
 * Mint under the cross-tab ordinal lock: the durable ordinal is refreshed
 * inside the lock so two tabs can never mint the same `guest-N`. Browsers
 * without Web Locks fall back to the sync mint — memory-only storage is
 * single-copy anyway.
 */
export async function mintGuestSessionPersonLocked(
  validate?: () => void,
): Promise<GuestSessionPerson> {
  const locks = lockManager();
  if (!locks) {
    validate?.();
    return mintGuestSessionPerson();
  }
  return locks.request("opensesame-guest-ordinal", async () => {
    await kvRefresh(GUEST_ORDINAL_KEY, 64);
    // The lock acquisition yields. Revalidate at the actual person-mint
    // boundary so a sign-in that landed while waiting wins instead.
    validate?.();
    const person = mintGuestSessionPerson();
    await persistGuestOrdinal();
    return person;
  });
}

/**
 * Active guest for this tab, minting under the cross-tab ordinal lock when
 * none is stored yet — concurrent first-boot tabs can never mint the same
 * `guest-N`. The lock is re-checked inside so a concurrent same-tab caller
 * resumes the mint it raced instead of replacing it.
 */
export async function guestSessionPersonLocked(): Promise<GuestSessionPerson> {
  const stored = readGuestSessionPerson();
  if (stored) return stored;
  if (isolatedActive)
    throw new Error("The guest vault's identity could not be verified.");
  const locks = lockManager();
  if (!locks) return mintGuestSessionPerson();
  return locks.request("opensesame-guest-ordinal", async () => {
    await kvRefresh(GUEST_ORDINAL_KEY, 64);
    const existing = readGuestSessionPerson();
    if (existing) return existing;
    const person = mintGuestSessionPerson();
    await persistGuestOrdinal();
    return person;
  });
}

/** Read the tab's guest principal without minting one. */
export function readGuestSessionPerson(): GuestSessionPerson | null {
  if (isolatedActive) return isolatedPerson;
  try {
    const isolated = sessionStore().getItem(ISOLATED_SESSION_KEY);
    if (isolated) {
      const person = readStoredGuestPerson(isolated);
      if (person) {
        isolatedPerson = person;
        isolatedActive = true;
        isolatedOwner = Symbol("guest-person");
        return person;
      }
    }
    const cached = sessionStore().getItem(GUEST_SESSION_KEY);
    if (cached) {
      const fromCache = readStoredGuestPerson(cached);
      if (fromCache) return fromCache;
    }
  } catch {
    /* fall through to durable copy */
  }
  const durable = kvGet(GUEST_PERSON_KEY);
  if (!isString(durable)) return null;
  const person = readStoredGuestPerson(durable);
  if (person) {
    try {
      sessionStore().setItem(GUEST_SESSION_KEY, JSON.stringify(person));
    } catch {
      /* ignore */
    }
  }
  return person;
}

/**
 * Active guest for this tab. Resume keeps the same principal; call
 * `mintGuestSessionPerson` (via continue-as-guest) for a fresh one.
 */
export function guestSessionPerson(): GuestSessionPerson {
  const stored = readGuestSessionPerson();
  if (stored) return stored;
  if (isolatedActive)
    throw new Error("The guest vault's identity could not be verified.");
  return mintGuestSessionPerson();
}

export function clearGuestSessionPerson(): void {
  clearIsolatedGuestPerson();
  kvDelete(GUEST_PERSON_KEY);
  try {
    sessionStore().removeItem(GUEST_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

export function isGuestDisplayName(name: string): boolean {
  const trimmed = name.trim();
  return (
    trimmed === GUEST_PERSON_NAME ||
    trimmed.toLowerCase() === "guest" ||
    GUEST_NAME_LEGACY_RE.test(trimmed) ||
    GUEST_NAME_SLUG_RE.test(trimmed) ||
    trimmed.startsWith("guest@")
  );
}

type IdentityRef = {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly enabled: boolean;
};

type MembershipRef = {
  readonly organizationId: string;
  readonly principalId: string;
  readonly role: OrganizationRole;
};

export function isGuestPersonEntry(entry: IdentityRef): boolean {
  return (
    entry.kind === "person" &&
    (entry.id === GUEST_PERSON_ID ||
      entry.id.startsWith("local_guest_") ||
      isGuestDisplayName(entry.name))
  );
}

/** Every guest person currently in a directory (never invents a singleton). */
export function guestPersonIds(
  entries: readonly IdentityRef[],
): readonly string[] {
  return entries.filter(isGuestPersonEntry).map((entry) => entry.id);
}

export function hasClaimedOperatorEntry(
  entries: readonly IdentityRef[],
  memberships: readonly MembershipRef[],
): boolean {
  return memberships.some(
    (row) =>
      (row.role === "owner" || row.role === "admin") &&
      entries.some(
        (entry) =>
          entry.id === row.principalId &&
          entry.kind === "person" &&
          entry.enabled &&
          !isGuestPersonEntry(entry),
      ),
  );
}

/** Refuse guest admin; refuse guest owner once a claimed operator exists. */
export function guestMembershipError(
  entries: readonly IdentityRef[],
  memberships: readonly MembershipRef[],
  person: IdentityRef,
  role: OrganizationRole,
): string | null {
  if (!isGuestPersonEntry(person)) return null;
  if (role === "admin") {
    return "Guest identities cannot be operators. Keep guest as Member and grant resources on Access.";
  }
  if (role === "owner" && hasClaimedOperatorEntry(entries, memberships)) {
    return "Guest identities cannot own the organization once an operator is assigned.";
  }
  return null;
}

/** When a claimed person becomes owner/admin, demote guest operators. */
export function demoteGuestOperators(
  entries: readonly IdentityRef[],
  memberships: readonly MembershipRef[],
  organizationId: string,
): MembershipRef[] {
  return memberships.map((row) => {
    if (row.organizationId !== organizationId) return row;
    const person = entries.find((entry) => entry.id === row.principalId);
    if (
      person &&
      isGuestPersonEntry(person) &&
      (row.role === "owner" || row.role === "admin")
    ) {
      return { ...row, role: "member" as const };
    }
    return row;
  });
}
