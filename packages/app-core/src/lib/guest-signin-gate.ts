import { requireGuestReturnCleared } from "./guest-continuation.js";
import { settleGuestReturnSignOut } from "./guest-return-signout.js";
import { isLocalOnlyGuest } from "./guest-session-context.js";

/** Fence a new federated sign-in against unfinished guest sign-out. */
export async function prepareFederatedSignIn(check: () => void): Promise<void> {
  if (isLocalOnlyGuest())
    throw new Error(
      "This vault is local only. Sign out and start a new guest session to connect services.",
    );
  check();
  await settleGuestReturnSignOut();
  check();
  requireGuestReturnCleared();
}
