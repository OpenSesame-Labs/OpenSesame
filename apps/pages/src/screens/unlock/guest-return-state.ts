import {
  inspectStoredGuestContinuation,
  peekGuestContinuation,
} from "@opensesame/app-core/lib/guest-continuation.js";
import { GUEST_RETURN_EXPIRED } from "@opensesame/app-core/lib/guest-signout-copy.js";

/** Describe a pending legacy callback without promising that it can resume. */
export function guestReturnState(guestKeyless: boolean, error: string | null) {
  return {
    continuing: guestKeyless && peekGuestContinuation() !== null,
    expired:
      guestKeyless &&
      error === GUEST_RETURN_EXPIRED &&
      inspectStoredGuestContinuation().kind === "present",
  };
}
