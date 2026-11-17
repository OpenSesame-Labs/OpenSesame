/** Persistently fence browser Identity sessions across completed sign-outs. */
import { maybePage } from "../ports.js";
import { isDeviceIdentityMode } from "./device-identity.js";
import {
  advanceGuestReturnEpoch,
  assertGuestReturnEpoch,
  captureGuestReturnEpoch,
} from "./guest-return-epoch.js";
import { isLocalOnlyGuest } from "./guest-session-context.js";
import { IdentityError } from "./identity-session-types.js";
import { assertNoPendingSignOut } from "./identity-signout-fence.js";

function needsSharedEpoch(): boolean {
  return Boolean(maybePage()) && !isDeviceIdentityMode();
}

export function captureIdentityEpoch(): string | null {
  if (!needsSharedEpoch()) return null;
  const epoch = captureGuestReturnEpoch();
  if (!epoch)
    throw new IdentityError(
      "This browser cannot verify shared sign-out. Check browser storage.",
      409,
    );
  return epoch;
}

export function assertIdentityEpoch(epoch: string | null): void {
  if (epoch === null) return;
  try {
    assertGuestReturnEpoch(epoch);
  } catch {
    throw new IdentityError("The session ended. Sign in again.", 409);
  }
}

export function identityEpochChanged(epoch: string | null): boolean {
  try {
    assertIdentityEpoch(epoch);
    return false;
  } catch {
    return true;
  }
}

export function advanceIdentityEpoch(): void {
  if (needsSharedEpoch()) advanceGuestReturnEpoch();
}

export function assertIdentityAdoption(
  owner: string | null,
  check: (() => void) | undefined,
  ended: () => never,
): void {
  try {
    if (isLocalOnlyGuest()) throw new Error("Local-only guest.");
    assertNoPendingSignOut();
    assertIdentityEpoch(owner);
    check?.();
  } catch {
    ended();
  }
}
