import { lockManager, originFiles } from "../ports.js";
import { isLocalOnlyGuest } from "./guest-session-context.js";
import {
  assertIdentityEpoch,
  captureIdentityEpoch,
} from "./identity-owner-epoch.js";
import type { ProvisionalOptions } from "./identity-provisional.js";
import {
  IdentityError,
  type IdentitySession,
} from "./identity-session-types.js";
import { assertNoPendingSignOut } from "./identity-signout-fence.js";
import { kvDurability } from "./kv.js";

/** Keep the entry guard through every provisional-identity await. */
export async function beginProvisional(
  options: ProvisionalOptions | undefined,
  run: (
    options: ProvisionalOptions,
    owner: string | null,
  ) => Promise<IdentitySession>,
  settle: () => Promise<void>,
): Promise<IdentitySession> {
  const owner = captureIdentityEpoch();
  const check = () => {
    assertIdentityEpoch(owner);
    assertNoPendingSignOut();
    if (isLocalOnlyGuest())
      throw new Error(
        "This vault is local only. Sign out and start a new guest session to connect services.",
      );
    options?.check?.();
  };
  check();
  await settle();
  check();
  const guarded = { ...options, check };
  const locks = lockManager();
  if (locks)
    return locks.request("opensesame:identity-cookie-session", () =>
      run(guarded, owner),
    );
  if (options?.fresh && originFiles() && kvDurability() === "persistent")
    throw new IdentityError(
      "This browser cannot safely connect a guest to Identity.",
      409,
    );
  return run(guarded, owner);
}
