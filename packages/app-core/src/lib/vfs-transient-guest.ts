/** Private in-document VFS for an unprotected guest, never an OPFS namespace. */
import { isIsolatedGuestVaultId } from "./guest-vault-id.js";

type Transient = {
  owner: symbol;
  values: Map<string, string>;
  retired: boolean;
  blocked: boolean;
  frozen: Promise<void> | null;
  thaw: (() => void) | null;
};
const tombs = new Map<string, Transient>();

export function beginTransientGuest(tomb: string): symbol {
  if (!isIsolatedGuestVaultId(tomb) || tombs.has(tomb))
    throw new Error("Invalid or reused guest session.");
  const owner = Symbol("guest-vfs");
  tombs.set(tomb, {
    owner,
    values: new Map(),
    retired: false,
    blocked: false,
    frozen: null,
    thaw: null,
  });
  return owner;
}

export function isTransientGuest(tomb: string): boolean {
  return tombs.has(tomb);
}

function tombFor(key: string): string | null {
  if (!key.startsWith("tomb/")) return null;
  const end = key.indexOf("/", 5);
  return end < 0 ? null : key.slice(5, end);
}

export function isTransientGuestKey(key: string): boolean {
  const tomb = tombFor(key);
  return tomb !== null && tombs.has(tomb);
}

/** A retired guest still fences writes, but must not hide a protected header. */
export function isReadableTransientGuestKey(key: string): boolean {
  const tomb = tombFor(key);
  const store = tomb ? tombs.get(tomb) : null;
  return Boolean(store && !store.retired);
}

export function readTransientGuest(key: string): string | null {
  const tomb = tombFor(key);
  return (tomb ? tombs.get(tomb)?.values.get(key) : null) ?? null;
}

export function writeTransientGuest(
  key: string,
  value: string,
  check: () => void = () => {},
): boolean | Promise<boolean> {
  const tomb = tombFor(key);
  const store = tomb ? tombs.get(tomb) : null;
  if (!store) return false;
  if (store.retired) throw new Error("The guest session has ended.");
  if (store.blocked)
    throw new Error(
      "Guest protection could not be verified. Retry protecting the vault before making changes.",
    );
  if (store.frozen)
    return store.frozen.then(() => {
      if (store.retired) throw new Error("The guest session has ended.");
      return writeTransientGuest(key, value, check);
    });
  check();
  store.values.set(key, value);
  return true;
}

export function deleteTransientGuest(
  key: string,
  check: () => void = () => {},
): boolean | Promise<boolean> {
  const tomb = tombFor(key);
  const store = tomb ? tombs.get(tomb) : null;
  if (!store) return false;
  if (store.retired) throw new Error("The guest session has ended.");
  if (store.blocked)
    throw new Error(
      "Guest protection could not be verified. Retry protecting the vault before making changes.",
    );
  if (store.frozen)
    return store.frozen.then(() => {
      if (store.retired) throw new Error("The guest session has ended.");
      return deleteTransientGuest(key, check);
    });
  check();
  store.values.delete(key);
  return true;
}

/** No operation can have observed an unpublished, empty transient store. */
export function discardUnpublishedTransientGuest(
  tomb: string,
  owner: symbol,
): void {
  const held = tombs.get(tomb);
  if (!held || held.owner !== owner || held.values.size || held.frozen)
    throw new Error("The guest session could not be discarded safely.");
  tombs.delete(tomb);
}

/** Called with the exclusive open lease after earlier queued writes settle. */
export function releaseRetiredTransientGuest(tomb: string): void {
  const held = tombs.get(tomb);
  if (held?.retired) tombs.delete(tomb);
}

export function freezeTransientGuest(
  tomb: string,
  owner: symbol,
): ReadonlyMap<string, string> {
  const store = tombs.get(tomb);
  if (!store || store.owner !== owner || store.retired || store.frozen)
    throw new Error("The guest session has ended.");
  store.frozen = new Promise<void>((resolve) => {
    store.thaw = resolve;
  });
  return new Map(store.values);
}

export function thawTransientGuest(tomb: string, owner: symbol): void {
  const store = tombs.get(tomb);
  if (!store || store.owner !== owner) return;
  const thaw = store.thaw;
  store.frozen = null;
  store.thaw = null;
  thaw?.();
}

export function setTransientGuestBlocked(
  tomb: string,
  owner: symbol,
  blocked: boolean,
): void {
  const store = tombs.get(tomb);
  if (!store || store.owner !== owner)
    throw new Error("The guest session has ended.");
  if (store.retired) return;
  store.blocked = blocked;
}

export function transientGuestBlocked(tomb: string, owner: symbol): boolean {
  const store = tombs.get(tomb);
  return Boolean(store && store.owner === owner && store.blocked);
}

export function endTransientGuest(tomb: string, owner: symbol): void {
  const held = tombs.get(tomb);
  if (!held || held.owner !== owner) return;
  held.values.clear();
  held.retired = true;
  thawTransientGuest(tomb, owner);
}

/** The same tomb is durable after promotion and may be opened normally. */
export function releaseTransientGuest(tomb: string, owner: symbol): void {
  const held = tombs.get(tomb);
  if (!held || held.owner !== owner)
    throw new Error("The guest session has ended.");
  tombs.delete(tomb);
  held.thaw?.();
}
