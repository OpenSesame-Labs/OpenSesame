/**
 * The guest side of the origin-wide sign-out epoch. A guest captures the
 * shared sign-out generation (identity-shared-signout.ts) when it opens, and
 * any later sign-out in any tab ends the work that guest started. Without
 * durable storage there is no cross-tab epoch: such a guest is local only.
 */
import { atRestKeyNow } from "./at-rest/key.js";
import {
  assertSignOutEpoch,
  captureSignOutEpoch,
} from "./identity-shared-signout.js";

/** The current epoch, or null when it cannot be relied on across tabs. */
export function captureGuestReturnEpoch(): string | null {
  if (atRestKeyNow()?.durable !== true) return null;
  const epoch = captureSignOutEpoch();
  return epoch === null ? null : String(epoch);
}

/** Throws once any tab has signed out since `expected` was captured. */
export function assertGuestReturnEpoch(expected: string): void {
  const captured = Number(expected);
  if (!Number.isSafeInteger(captured))
    throw new Error("The guest session ended. Connect again.");
  try {
    assertSignOutEpoch(captured);
  } catch {
    throw new Error("The guest session ended. Connect again.");
  }
}

export type GuestEpochGuard = Readonly<{
  epoch: string | null;
  check: () => void;
}>;

/** Capture before guest opening can yield, and recheck through publication. */
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
