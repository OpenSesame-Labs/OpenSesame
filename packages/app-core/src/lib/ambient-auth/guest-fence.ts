import { requireGuestReturnCleared } from "../guest-continuation.js";
import {
  captureGuestReturnSignOutCheck,
  restoreGuestReturnSignOut,
} from "../guest-return-signout.js";
import { activeGuestTomb } from "../guest-session-context.js";

/** Stop automatic sign-in while a guest return or sign-out is unfinished. */
export function captureAmbientGuestFence(): () => void {
  restoreGuestReturnSignOut();
  const check = captureGuestReturnSignOutCheck();
  return () => {
    if (activeGuestTomb() !== null)
      throw new Error(
        "Automatic sign-in is unavailable while a guest vault is open.",
      );
    check();
    requireGuestReturnCleared();
  };
}
