/** Durable origin-wide generation for temporary guest provider returns. */
import { host } from "../host.js";
import { localStore } from "../ports.js";
import { isSealedAtRest } from "./at-rest/cipher.js";
import { atRestKeyNow } from "./at-rest/key.js";
import { GUEST_RETURN_EPOCH_KEY } from "./guest-return-epoch-key.js";

const VALID_EPOCH =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** A missing, corrupt or memory-only record is never mistaken for a saved epoch. */
export function readGuestReturnEpoch(): string | null {
  if (atRestKeyNow()?.durable !== true)
    throw new Error("Guest session storage is not durable.");
  const physical = host().storage?.local;
  if (!physical) throw new Error("Guest session storage is unavailable.");
  const raw = physical.getItem(GUEST_RETURN_EPOCH_KEY);
  if (raw !== null && !isSealedAtRest(raw))
    throw new Error("Guest session storage could not be verified.");
  const value = localStore().getItem(GUEST_RETURN_EPOCH_KEY);
  if (raw === null && value === null) return null;
  if (raw === null || !value || !VALID_EPOCH.test(value))
    throw new Error("Guest session storage could not be verified.");
  return value;
}

/** Replace the generation with a fresh random value and verify the physical write. */
export function advanceGuestReturnEpoch(): string {
  readGuestReturnEpoch();
  const next = crypto.randomUUID();
  localStore().setItem(GUEST_RETURN_EPOCH_KEY, next);
  if (readGuestReturnEpoch() !== next)
    throw new Error("Guest sign-out could not be saved. Try again.");
  return next;
}

/** Initialize before an issuance; every return requires the same durable value. */
export function requireGuestReturnEpoch(): string {
  return readGuestReturnEpoch() ?? advanceGuestReturnEpoch();
}

/** An unfenced guest may use its local vault, but cannot start remote work. */
export function captureGuestReturnEpoch(): string | null {
  try {
    return requireGuestReturnEpoch();
  } catch {
    return null;
  }
}

export function assertGuestReturnEpoch(expected: string): void {
  if (readGuestReturnEpoch() !== expected)
    throw new Error("The guest session ended. Connect again.");
}

/** Capture before guest opening can yield, and recheck through publication. */
export type GuestEpochGuard = Readonly<{
  epoch: string | null;
  check: () => void;
}>;

export function guestEpochGuard(operation: () => void): GuestEpochGuard {
  const epoch = captureGuestReturnEpoch();
  return {
    epoch,
    check() {
      operation();
      if (epoch !== null) assertGuestReturnEpoch(epoch);
    },
  };
}
