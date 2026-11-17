import type { CallbackCapture } from "./federation-action-owner.js";
import { FederationError } from "./federation-error.js";
import type { PendingAuth } from "./federation-pending.js";
import { assertGuestReturnEpoch } from "./guest-return-epoch.js";

/** Keep the initiating epoch through exchange, publication, and adoption. */
export function bindPendingOwner(
  captured: CallbackCapture,
  pending: PendingAuth,
) {
  const assertEpoch = () => {
    try {
      assertGuestReturnEpoch(pending.authEpoch ?? "");
    } catch {
      throw new FederationError(
        "sign_in_cancelled",
        "That sign-in was ended by a sign-out. Start again.",
      );
    }
  };
  return {
    generation: captured.generation,
    assertCurrent() {
      captured.assertCurrent();
      assertEpoch();
    },
    assertConfiguration() {
      captured.assertConfiguration();
      assertEpoch();
    },
  };
}
