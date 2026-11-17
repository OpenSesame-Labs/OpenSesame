/** Durable, sealed proof for finishing a bound-session sign-out after reload. */
import { host } from "../host.js";
import { type WebStorage, localStore, maybePage } from "../ports.js";
import { isSealedAtRest } from "./at-rest/cipher.js";
import { atRestKeyNow } from "./at-rest/key.js";
import {
  type CookieBinding,
  validCookieBinding,
} from "./identity-cookie-binding.js";
import { IDENTITY_REVOCATION_PREFIX } from "./identity-revocation-key.js";

export type BoundRevocation = {
  key: string;
  binding: CookieBinding;
  orphan: boolean;
};

export class RevocationStorageUnavailableError extends Error {
  constructor() {
    super("Sign-out storage is unavailable.");
  }
}

function physicalStore(): WebStorage | null {
  try {
    const physical = host().storage?.local;
    if (physical) return physical;
    // A non-browser process has no shared Web Storage to inspect.
    if (!maybePage()) return null;
  } catch {
    // A blocked storage getter is unknown, not an empty journal.
  }
  throw new RevocationStorageUnavailableError();
}

function pendingKeys(): string[] {
  try {
    const physical = physicalStore();
    if (!physical) return [];
    const keys: string[] = [];
    for (let index = 0; index < physical.length; index += 1) {
      const key = physical.key(index);
      if (key?.startsWith(IDENTITY_REVOCATION_PREFIX)) keys.push(key);
    }
    return keys;
  } catch {
    throw new RevocationStorageUnavailableError();
  }
}

function parse(key: string, raw: string): BoundRevocation {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || !("binding" in value))
    throw new Error("Pending sign-out could not be verified.");
  const binding = value.binding;
  if (
    !binding ||
    typeof binding !== "object" ||
    !("issuerOrigin" in binding) ||
    typeof binding.issuerOrigin !== "string" ||
    !validCookieBinding(binding, binding.issuerOrigin) ||
    !("orphan" in value) ||
    typeof value.orphan !== "boolean"
  )
    throw new Error("Pending sign-out could not be verified.");
  return { key, binding, orphan: value.orphan };
}

/** Use physical storage presence to avoid treating unreadable data as absent. */
export function hasPendingBoundRevocation(): boolean {
  return pendingKeys().length > 0;
}

export function readBoundRevocation(key: string): BoundRevocation | null {
  if (!key.startsWith(IDENTITY_REVOCATION_PREFIX))
    throw new Error("Invalid pending sign-out.");
  const physical = physicalStore();
  if (!physical) throw new RevocationStorageUnavailableError();
  const sealed = physical.getItem(key);
  if (sealed === null) return null;
  if (!isSealedAtRest(sealed) || atRestKeyNow()?.durable !== true)
    throw new Error("Pending sign-out could not be verified.");
  const value = localStore().getItem(key);
  if (!value) throw new Error("Pending sign-out could not be verified.");
  return parse(key, value);
}

export function listBoundRevocations(): BoundRevocation[] {
  return pendingKeys().flatMap((key) => {
    const value = readBoundRevocation(key);
    return value ? [value] : [];
  });
}

/** Do not discard a proof until its sealed journal entry is readable on disk. */
export function stageBoundRevocation(
  binding: CookieBinding,
  orphan: boolean,
): BoundRevocation {
  if (atRestKeyNow()?.durable !== true || !host().storage?.local)
    throw new Error("Sign-out storage is unavailable.");
  const key = IDENTITY_REVOCATION_PREFIX + crypto.randomUUID();
  const value = JSON.stringify({ binding, orphan });
  localStore().setItem(key, value);
  const staged = readBoundRevocation(key);
  if (
    !staged ||
    JSON.stringify({ binding: staged.binding, orphan: staged.orphan }) !== value
  )
    throw new Error("Pending sign-out could not be saved.");
  return staged;
}

export function forgetBoundRevocation(key: string): void {
  localStore().removeItem(key);
  if (host().storage?.local?.getItem(key) !== null)
    throw new Error("Completed sign-out could not be saved.");
}
